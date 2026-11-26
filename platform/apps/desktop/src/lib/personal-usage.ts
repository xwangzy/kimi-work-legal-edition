/**
 * 个人用量口径（第 66 批 V40 P0-5；第 68 批重构）。纯函数，“设置 · 套餐与用量”页、首页额度提示条、用户菜单与用例共用。
 *
 * 只讲“我”：比例全部来自控制面按逐请求账本算出的值（/v1/quota 的 personal 块；旧云端回退到 own / firm），不做金额或点数换算。
 * 第 68 批核对出的三处口径偏差，在客户端这样收口（控制面根治写在 research/…V42…/impl-usage.md）：
 *   1) 明细每行的 charge_ratio 按“个人上限 ?? 每席位额度”算，大数字按 personal 的分母算（单席位含加量）——用 rowScale 折到同一分母；
 *   2) firm.in_flight_ratio 是全所在途 ÷ 全所额度——只有单席位（分母相同、在途就是本人的）才画进个人条；
 *   3) 5 小时窗口与旧云端的 models / firm.used_ratio 是全所数——多人律所不显示（被窗口卡住时只说状态）。
 */
import type { QuotaStatus, UsagePageRow } from "../api.ts";
import { fmtPct, modelLabel } from "./firm-usage.ts";

type Paused = "allowance" | "cap" | "burst" | "seat";

/** 个人用量比例（旧云端没有 personal 时）：有个人上限或多人律所用本人分母（own）；单人工作室的本期额度就是本人套餐。 */
export function personalUsedRatio(q: Pick<QuotaStatus, "firm" | "own">): number {
  if (q.own && (q.own.denominator === "account_limit" || (q.firm?.seats ?? 1) > 1)) return q.own.used_ratio;
  return q.firm?.used_ratio ?? q.own?.used_ratio ?? 0;
}

export interface PersonalView {
  /** 本期已用（占本人本期额度）。 */
  used: number;
  /** 进行中任务的预留（只在单席位时有值，见文件头 2）。 */
  inFlight: number;
  /** 1 − 已用 − 预留：条上空着的部分。 */
  available: number;
  /** 本期此刻真正还能用的：被额度、上限、个人额度卡住时取云端算的值；5 小时窗口是短期限制，单独一行，不压低月度剩余。 */
  left: number;
  /** 云端算的“此刻还能用多少”（含 5 小时窗口）；旧云端为 null。 */
  now: number | null;
  limitedBy: Paused | null;
  paused: Paused | null;
  /** 单席位：本所额度就是本人额度，5 小时窗口、在途、旧云端按模型都是本人的。 */
  solo: boolean;
  /**
   * 本人分母是不是一道真的限制：单席位、设了个人上限、或套餐让每人额度对个人生效。多人律所里没设个人上限时，分母只是“每人份额”
   * （用超了照样能用律所共用的额度，以云端暂停为准）——这时用到 100% 不算用完、不报“不足 10%”。
   */
  capped: boolean;
}

/** 个人口径（新云端给 personal；旧云端回退）。 */
export function personalView(q: QuotaStatus): PersonalView {
  const p = q.personal;
  const solo = (q.firm?.seats ?? 1) <= 1;
  // 第 68 批：新云端直接给本人的在途预留（personal.in_flight_ratio，同一分母）；旧云端只有全所在途，只在单席位时采用
  const inFlight = typeof p?.in_flight_ratio === "number" && Number.isFinite(p.in_flight_ratio) ? Math.max(0, p.in_flight_ratio) : solo ? Math.max(0, q.firm?.in_flight_ratio ?? 0) : 0;
  const used = Math.max(0, p ? p.used_ratio : personalUsedRatio(q));
  const available = Math.max(0, 1 - Math.min(1, used) - inFlight);
  const now = p ? p.remaining_ratio : null;
  const limitedBy = p?.limited_by ?? null;
  const left = now !== null && limitedBy !== null && limitedBy !== "burst" ? Math.max(0, Math.min(available, now)) : available;
  const capped = solo || !q.own || q.own.enforced || q.own.denominator === "account_limit";
  return { used, inFlight, available, left, now, limitedBy, paused: (p ? p.paused : q.firm?.paused) ?? null, solo, capped };
}

/** 5 小时窗口一栏只用窗口自己的分母（窗口上限 = 本期额度的 pct%）：已用、预留、此刻还可用都折到窗口上。 */
export function burstView(b: { pct: number; used_ratio: number }, v: Pick<PersonalView, "inFlight" | "now" | "limitedBy">): { used: number; inFlight: number; available: number } {
  const cap = b.pct > 0 ? b.pct / 100 : 1;
  const used = Math.max(0, b.used_ratio);
  const inFlight = Math.min(Math.max(0, 1 - used), v.inFlight / cap);
  const available = v.limitedBy === "burst" && v.now !== null ? Math.max(0, Math.min(1, v.now / cap)) : Math.max(0, 1 - used - inFlight);
  return { used, inFlight, available };
}

/** 主色调：用完或被停（额度、上限、个人额度）= full；用到 80% 或剩不到 10% = high。5 小时放缓不把整月染红（那一行自己显示）。 */
export function usageTone(v: Pick<PersonalView, "used" | "left" | "paused" | "capped">): "ok" | "high" | "full" {
  if (v.paused === "allowance" || v.paused === "cap" || v.paused === "seat") return "full";
  if (v.capped && (v.used >= 1 || v.left <= 0)) return "full";
  if (v.used >= 0.8 || (v.capped && v.left < 0.1)) return "high";
  return "ok";
}

/** 页面顶上的一句状态（没有要说的为 null）。resetText 形如“12 月 1 日 00:00”。 */
export function usageStatus(q: QuotaStatus, v: PersonalView, resetText: string, burstBack: string): { tone: "stop" | "warn"; text: string } | null {
  const per = q.period?.kind === "week" ? "本周" : "本月";
  const after = resetText ? `${resetText} 重置后恢复` : "下期重置后恢复";
  if (v.paused === "allowance" || (v.paused === null && v.capped && v.used >= 1)) return { tone: "stop", text: `${per}额度已用完，新任务暂不能发起；${after}。` };
  if (v.paused === "cap") return { tone: "stop", text: `已到管理员设定的${per}上限，新任务暂不能发起；${after}。` };
  if (v.paused === "seat") return { tone: "stop", text: `你的个人额度已用完，新任务暂不能发起；${after}。` };
  if (v.paused === "burst") return { tone: "warn", text: `最近 ${q.burst?.hours ?? 5} 小时用量较多，AI 处理暂时放缓${burstBack ? `，${burstBack} 起恢复` : "，稍后自动恢复"}。` };
  if (!v.capped && v.used >= 1) return { tone: "warn", text: `已超出你${per}的个人份额；律所共用额度还有余量时可以继续使用。` };
  if (v.capped && v.left < 0.1) return { tone: "warn", text: `${per}剩余不足 ${fmtPct(0.1)}；需要更多额度，请联系客户经理或客服。` };
  return null;
}

/** 剩余被别的约束压低时的说明（left 明显小于 available）。 */
export function limitedNote(v: Pick<PersonalView, "left" | "available" | "limitedBy">): string | null {
  if (v.available - v.left < 0.005) return null;
  if (v.limitedBy === "cap") return "受管理员设定的上限限制";
  if (v.limitedBy === "seat") return "受个人额度限制";
  if (v.limitedBy === "allowance") return "受律所共用额度限制";
  return null;
}

/**
 * 明细行“计入额度”的分母折算系数（文件头 1）：行的 charge_ratio 按 own 的分母算，大数字按 personal 的分母算；
 * 两者的分子是同一笔本人用量，所以 系数 = personal 已用 ÷ own 已用。控制面改成同一分母后会带 ratio_basis = "personal"，此时不再折算。
 */
export function rowScale(q: QuotaStatus): number {
  if ((q as { ratio_basis?: string }).ratio_basis === "personal") return 1;
  const own = q.own?.used_ratio ?? 0;
  const mine = personalView(q).used;
  if (!(own > 0) || !(mine > 0)) return 1;
  return mine / own;
}

/** 明细一行（own_recent 与翻页行合并后的统一形态）。 */
export type UsageRow = Pick<UsagePageRow, "at" | "kind" | "alias" | "label" | "tokens_in" | "tokens_cached" | "tokens_out" | "outcome" | "partial" | "estimated"> & {
  charge_ratio?: number;
  /** 旧云端 own_recent 才有（内部单位）；只用来判断“是否计入”，不显示。 */
  charge?: number;
  pending?: boolean;
  in_period?: boolean;
};

/** 明细“计入额度”一格：counted = 计入了本期额度；text 是百分比或“未计入”的原因。不出现金额与原始计数。 */
export function rowCharge(r: UsageRow, scale: number): { counted: boolean; text: string } {
  if (r.partial) return { counted: false, text: "未计入 · 中途中断" };
  if (r.pending) return { counted: false, text: "未计入 · 待核对" };
  const ratio = typeof r.charge_ratio === "number" ? r.charge_ratio * scale : null;
  const zero = ratio !== null ? ratio <= 0 : r.charge === 0;
  if (r.outcome !== "ok" && zero) return { counted: false, text: "未计入 · 未成功" };
  if (ratio === null) return { counted: true, text: "已计入" };
  return { counted: true, text: `${fmtPct(ratio)}${r.estimated ? "（估算）" : ""}` };
}

/** 套餐说明给律师看的版本：去掉金额与原始计数（“84 元额度（按价目计）”“2,000 万 token”），只留时长与“约 N 单”这类说法。 */
export function planNoteText(note: string | null | undefined): string {
  return String(note ?? "")
    .replace(/[\d,.]+\s*元额度（按价目计）/g, "")
    .replace(/[\d,.]+\s*[万亿]?\s*tokens?/gi, "")
    .replace(/[，,]\s*(?=[，,]|$)/g, "")
    .replace(/^[，,\s]+/, "")
    .trim();
}

const DAY = 86_400_000;
const bj = (iso: string | null | undefined): Date | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t + 8 * 3600_000) : null;
};
const pad = (n: number) => String(n).padStart(2, "0");

/** 北京时间“HH:mm”。 */
export function bjClock(iso: string | null | undefined): string {
  const d = bj(iso);
  return d ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : "";
}

/** 北京时间“M 月 D 日 HH:mm”。 */
export function bjDayTime(iso: string | null | undefined): string {
  const d = bj(iso);
  return d ? `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : "";
}

/** 距重置还有多久：“还有 4 天”“还有 5 小时”“不到 1 小时”；已过或没有时刻为空串。 */
export function resetCountdown(resetsAt: string | null | undefined, nowMs: number): string {
  const t = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(t) || t <= nowMs) return "";
  const ms = t - nowMs;
  if (ms >= DAY) return `还有 ${Math.floor(ms / DAY)} 天`;
  if (ms >= 3600_000) return `还有 ${Math.floor(ms / 3600_000)} 小时`;
  return "不到 1 小时";
}

/** 本期时间已过去多少（0–1），给进度条上的“今天”刻度用；没有周期为 null。 */
export function periodElapsed(p: QuotaStatus["period"] | undefined, nowMs: number): number | null {
  const s = p?.start ? Date.parse(p.start) : NaN;
  const e = p?.resets_at ? Date.parse(p.resets_at) : NaN;
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  return Math.min(1, Math.max(0, (nowMs - s) / (e - s)));
}

/** 明细按北京日期分组（新的在前，组内保持原顺序）：“今天”“昨天”“11 月 24 日”；earlier = 整组都不在本期。 */
export function dayGroups<T extends { at: string; in_period?: boolean }>(rows: T[], nowMs: number): { key: string; label: string; earlier: boolean; rows: T[] }[] {
  const out: { key: string; label: string; earlier: boolean; rows: T[] }[] = [];
  const today = bj(new Date(nowMs).toISOString())!;
  const dayKey = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const tk = dayKey(today);
  const yk = dayKey(new Date(today.getTime() - DAY));
  for (const r of rows) {
    const d = bj(r.at);
    const key = d ? dayKey(d) : "—";
    let g = out[out.length - 1];
    if (!g || g.key !== key) {
      const label = !d ? "时间不详" : key === tk ? "今天" : key === yk ? "昨天" : d.getUTCFullYear() === today.getUTCFullYear() ? `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日` : `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
      g = { key, label, earlier: true, rows: [] };
      out.push(g);
    }
    g.rows.push(r);
    if (r.in_period !== false) g.earlier = false;
  }
  return out;
}

/** 本人本期按模型（新云端 own_models；旧云端只有单席位时 models 才是本人的）。份额从大到小，去掉 0。 */
export function ownModels(q: QuotaStatus, v: Pick<PersonalView, "solo">): { alias: string; label: string; share: number; requests: number }[] {
  const src = q.own_models ?? (v.solo ? (q.models ?? []) : []);
  return src
    .filter((m) => m.share > 0)
    .map((m) => ({ alias: m.alias, label: m.label ?? modelLabel(m.alias), share: m.share, requests: m.requests }))
    .sort((a, b) => b.share - a.share);
}
