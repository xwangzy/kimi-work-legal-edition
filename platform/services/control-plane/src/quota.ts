/**
 * 额度账本 v2（第 44 批，主文 §4.3；取代第 40 批的“内部单位 + 按席位累计回报”）。
 *
 * 第一性原理：律所买的是“每个席位每期一份 AI 额度”，律师关心的只是“这期用了多少、还剩多少、什么时候重置”——
 * 对外给百分比、剩余、单位与重置时间；分母是我方配置的额度（套餐每席位额度 × 席位 + 加量，或个人上限），来源写明。
 *
 * - 单位只有 tokens（上游 usage 原样）与 cny（价目表售价 × 实际 usage，内部微元）；已用量**一律从用量账本算**
 *   （usage-ledger.ts，按请求编号去重），这里只存额度配置、加量、上限与在途租约，不再另存一份累计数。
 * - 租约按席位领（网关键 tid|sid）：可发放 = min(租户余量, 上限余量, 频率窗口余量, 个人余量) − 各自的在途；
 *   余量不够这次请求所需（need）即 402——不会先放出去再超；超出的幅度至多是“实际 − 预占”。
 * - 回报带逐请求记录：控制面按价目版本重算、按请求编号去重、写账本，再记到对应租约的已用；重发安全。
 * - 统计周期按套餐（月 = 北京时间自然月；周 = 周一 0 点起）；加量跨期清零。
 * - 迁移（§4.6）：第 40 批的旧单位账本，本期已用冻结为比例 legacy_used_ratio，新账本从迁移时起计；历史月份只留比例。
 */
import { randomBytes } from "node:crypto";
import { periodBounds, seatQuotaUnits, unitOut, type PlanSpec, type QuotaUnit } from "./billing.ts";
import { usedIn, type UsageBook } from "./usage-ledger.ts";

export interface BoostRecord {
  at: string;
  pct: number;
  by: string | null;
}

export interface LeaseRecord {
  lease_id: string;
  holder: string;
  sid: string;
  uid: string | null;
  unit: QuotaUnit;
  units: number;
  granted_at: string;
  expires_at: string;
  used: number;
  closed_at: string | null;
  unreconciled: boolean;
}

export interface QuotaHistoryRow {
  period: string;
  used_ratio: number | null;
  legacy: boolean;
  unit: QuotaUnit | null;
  used: number | null;
  total: number | null;
}

export interface QuotaState {
  v: 2;
  cap_pct: number | null;
  cap_set_at: string | null;
  cap_set_by: string | null;
  period_key: string;
  period_from: string;
  period_to: string;
  boosts: BoostRecord[];
  legacy: { period_key: string; used_ratio: number } | null;
  history: QuotaHistoryRow[];
  leases: Record<string, LeaseRecord>;
  /** 本期已发过的提醒（键：期:对象:阈值），跨期清空。 */
  alerts_sent: string[];
}

export class QuotaError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const LEASE_TTL_MS = 5 * 60_000;
export const LEASE_MAX_TTL_MS = 30 * 60_000;
export const LEASE_GRACE_MS = 30 * 60_000;
export const LEASE_KEEP_MS = 7 * 24 * 3600_000;
/** 单次租约上限（tokens：2,000 万；cny：2,000 元 = 20 亿微元）。 */
export const LEASE_MAX_UNITS: Record<QuotaUnit, number> = { tokens: 20_000_000, cny: 2_000_000_000 };
export const MAX_OPEN_LEASES = 256;
export const MAX_BOOST_PCT = 1000;
const HOLDER_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/** 额度上下文：由控制面按租户当前套餐、席位、账号与账本组装。 */
export interface QuotaCtx {
  tid: string;
  plan: PlanSpec;
  seats: number;
  allowance_override: number | null;
  book: UsageBook;
  t: number;
  /** 成员（uid）的个人上限（内部单位；null = 不单设）。 */
  memberLimit: (uid: string) => number | null;
}

export function emptyQuota(plan: PlanSpec, t: number): QuotaState {
  const b = periodBounds(plan.period, t);
  return { v: 2, cap_pct: null, cap_set_at: null, cap_set_by: null, period_key: b.key, period_from: b.fromDay, period_to: b.toDay, boosts: [], legacy: null, history: [], leases: {}, alerts_sent: [] };
}

/**
 * 读回旧状态：v2 原样；第 40 批（allowance / period_used 内部单位）→ 本期已用冻结为比例，历史只留比例，上限照旧，在途租约作废
 * （旧网关的租约协议已不再接受，网关随本批一并升级）。
 */
export function migrateQuota(raw: unknown, plan: PlanSpec, t: number): QuotaState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  if (r.v === 2) return { ...emptyQuota(plan, t), ...r, leases: r.leases ?? {}, alerts_sent: r.alerts_sent ?? [], history: r.history ?? [], boosts: r.boosts ?? [] } as QuotaState;
  const q = emptyQuota(plan, t);
  if (r.cap_pct === null || (Number.isSafeInteger(r.cap_pct) && r.cap_pct >= 1 && r.cap_pct <= 100)) {
    q.cap_pct = r.cap_pct ?? null;
    q.cap_set_at = typeof r.cap_set_at === "string" ? r.cap_set_at : null;
    q.cap_set_by = typeof r.cap_set_by === "string" ? r.cap_set_by : null;
  }
  const oldTotal = (Number(r.allowance) || 0) + (Number(r.boost) || 0);
  if (typeof r.period === "string" && r.period === q.period_key && oldTotal > 0 && Number(r.period_used) > 0) q.legacy = { period_key: q.period_key, used_ratio: Math.min(1, Math.round((Number(r.period_used) / oldTotal) * 10_000) / 10_000) };
  if (Array.isArray(r.history))
    q.history = r.history.slice(-12).map((h: any) => ({ period: String(h.period), used_ratio: Number.isSafeInteger(h.total) && h.total > 0 ? Math.round(((Number(h.used) || 0) / h.total) * 10_000) / 10_000 : null, legacy: true, unit: null, used: null, total: null }));
  return q;
}

/** 本期加量的单位（按套餐额度的百分比）。 */
function allowanceOf(ctx: QuotaCtx): number {
  return ctx.allowance_override !== null ? ctx.allowance_override : ctx.seats * seatQuotaUnits(ctx.plan);
}

export function totalsOf(q: QuotaState, ctx: QuotaCtx): { allowance: number; boost: number; total: number; cap: number | null; boost_pct: number } {
  const allowance = allowanceOf(ctx);
  const boost_pct = q.boosts.reduce((s, b) => s + b.pct, 0);
  const boost = Math.ceil((allowance * boost_pct) / 100);
  const total = allowance + boost;
  return { allowance, boost, total, cap: q.cap_pct === null ? null : Math.floor((total * q.cap_pct) / 100), boost_pct };
}

export function ratio(n: number, d: number): number {
  if (d <= 0) return n > 0 ? 1 : 0;
  return Math.round((n / d) * 10_000) / 10_000;
}

/** 跨期：旧期入历史（比例由账本算），加量与提醒清空。每个入口先调用。 */
export function ensurePeriod(q: QuotaState, ctx: QuotaCtx): void {
  const b = periodBounds(ctx.plan.period, ctx.t);
  if (b.key === q.period_key) return;
  const old = ctx.book.tenant(ctx.tid, q.period_from, q.period_to);
  const tot = totalsOf(q, ctx).total;
  const unit = ctx.plan.quota_unit;
  const legacyUnits = q.legacy && q.legacy.period_key === q.period_key ? q.legacy.used_ratio * tot : 0;
  const used = usedIn(unit, old) + legacyUnits;
  q.history = [...q.history, { period: q.period_key, used_ratio: ratio(used, tot), legacy: legacyUnits > 0, unit, used: unitOut(unit, Math.round(used)), total: unitOut(unit, tot) }].slice(-12);
  q.period_key = b.key;
  q.period_from = b.fromDay;
  q.period_to = b.toDay;
  q.boosts = [];
  q.alerts_sent = [];
  if (q.legacy && q.legacy.period_key !== b.key) q.legacy = null;
}

/** 本期已用（内部单位）：账本 + 迁移冻结的旧比例折到本期总额度。 */
export function usedOf(q: QuotaState, ctx: QuotaCtx, uid?: string): number {
  const unit = ctx.plan.quota_unit;
  if (uid !== undefined) return usedIn(unit, ctx.book.member(ctx.tid, uid, q.period_from, q.period_to));
  const legacy = q.legacy && q.legacy.period_key === q.period_key ? Math.round(q.legacy.used_ratio * totalsOf(q, ctx).total) : 0;
  return usedIn(unit, ctx.book.tenant(ctx.tid, q.period_from, q.period_to)) + legacy;
}

export function windowUsed(ctx: QuotaCtx, uid: string | null): number {
  if (!ctx.plan.burst) return 0;
  const w = ctx.book.window(ctx.tid, uid, ctx.plan.burst.hours, ctx.t);
  return ctx.plan.quota_unit === "tokens" ? w.tokens : w.value;
}

/** 在途：未结案租约里尚未入账的（含到期、宽限期内的）。 */
export function outstanding(q: QuotaState, sid?: string): number {
  let s = 0;
  for (const l of Object.values(q.leases)) if (!l.closed_at && (sid === undefined || l.sid === sid)) s += Math.max(0, l.units - l.used);
  return s;
}

export function sweepLeases(q: QuotaState, t: number): void {
  for (const [id, l] of Object.entries(q.leases)) {
    const exp = Date.parse(l.expires_at);
    if (!l.closed_at && exp + LEASE_GRACE_MS <= t) {
      l.closed_at = new Date(t).toISOString();
      l.unreconciled = true;
    }
    if (l.closed_at && Date.parse(l.closed_at) + LEASE_KEEP_MS <= t) delete q.leases[id];
  }
}

/** 个人上限（内部单位）：账号个人上限 > 套餐“每席位额度对个人生效”；都没有 = null。 */
export function memberLimitOf(ctx: QuotaCtx, uid: string | null): { limit: number | null; source: "account_limit" | "seat_quota" } {
  const own = uid ? ctx.memberLimit(uid) : null;
  if (own !== null) return { limit: own, source: "account_limit" };
  return { limit: ctx.plan.enforce_seat_quota ? seatQuotaUnits(ctx.plan) : null, source: "seat_quota" };
}

export type LimitedBy = "cap" | "allowance" | "burst" | "seat";

/** 各约束下现在还能发放多少（已扣在途）。 */
export function availability(q: QuotaState, ctx: QuotaCtx, sid: string, uid: string | null): { avail: number; by: LimitedBy; parts: Record<LimitedBy, number> } {
  sweepLeases(q, ctx.t);
  const tot = totalsOf(q, ctx);
  const used = usedOf(q, ctx);
  const out = outstanding(q);
  const parts: Record<LimitedBy, number> = { allowance: tot.total - used - out, cap: Number.POSITIVE_INFINITY, burst: Number.POSITIVE_INFINITY, seat: Number.POSITIVE_INFINITY };
  if (tot.cap !== null) parts.cap = tot.cap - used - out;
  if (ctx.plan.burst) parts.burst = Math.floor((tot.total * ctx.plan.burst.pct) / 100) - windowUsed(ctx, null) - out;
  const ml = memberLimitOf(ctx, uid);
  if (ml.limit !== null && uid) parts.seat = ml.limit - usedOf(q, ctx, uid) - outstanding(q, sid);
  let by: LimitedBy = "allowance";
  for (const k of ["cap", "burst", "seat"] as const) if (parts[k] < parts[by]) by = k;
  return { avail: Math.max(0, parts[by]), by, parts };
}

const LIMIT_ERR: Record<LimitedBy, [string, string]> = {
  allowance: ["quota_exhausted", "本期 AI 额度已用完（100%），下期重置或请管理员加量"],
  cap: ["quota_cap_reached", "已到律所设定的本期用量上限"],
  burst: ["quota_burst", "短时间内用量过多（频率窗口已满），请稍后再试"],
  seat: ["quota_seat_limit", "你的个人额度已用完，请联系律所管理员"],
};

/** 领租约（按席位）。need = 本次请求预估所需（内部单位）。 */
export function leaseQuota(q: QuotaState, ctx: QuotaCtx, input: { sid: unknown; uid: string | null; holder: unknown; need: number; want?: unknown; ttl_ms?: unknown }): LeaseRecord & { limited_by: LimitedBy | null } {
  ensurePeriod(q, ctx);
  if (typeof input.holder !== "string" || !HOLDER_RE.test(input.holder)) throw new QuotaError(400, "holder_invalid", "网关实例标识不合法");
  if (typeof input.sid !== "string" || !SID_RE.test(input.sid)) throw new QuotaError(400, "sid_invalid", "席位编号不合法");
  if (Object.values(q.leases).filter((l) => !l.closed_at).length >= MAX_OPEN_LEASES) throw new QuotaError(429, "too_many_leases", "在途租约过多");
  const unit = ctx.plan.quota_unit;
  const need = Math.max(1, Math.ceil(input.need));
  const { avail, by } = availability(q, ctx, input.sid, input.uid);
  if (avail < need) {
    const [code, msg] = LIMIT_ERR[by];
    throw new QuotaError(402, code, msg);
  }
  const want = typeof input.want === "number" && Number.isSafeInteger(input.want) && input.want > 0 ? input.want : need * 4;
  // 每次至多发可发放的 1/4（不少于 need）：多个网关实例时，一个实例不会一次领走全部余量
  const units = Math.min(LEASE_MAX_UNITS[unit], avail, Math.max(need, Math.min(want, Math.ceil(avail / 4))));
  const ttl = typeof input.ttl_ms === "number" && Number.isFinite(input.ttl_ms) ? Math.min(LEASE_MAX_TTL_MS, Math.max(10_000, Math.floor(input.ttl_ms))) : LEASE_TTL_MS;
  const l: LeaseRecord = { lease_id: `ls_${randomBytes(12).toString("hex")}`, holder: input.holder, sid: input.sid, uid: input.uid, unit, units, granted_at: new Date(ctx.t).toISOString(), expires_at: new Date(ctx.t + ttl).toISOString(), used: 0, closed_at: null, unreconciled: false };
  q.leases[l.lease_id] = l;
  return { ...l, limited_by: units < Math.min(want, LEASE_MAX_UNITS[unit]) ? by : null };
}

/** 回报里某条记录入账后，记到它所属租约的已用（租约已过保留期则只进账本）。 */
export function chargeLease(q: QuotaState, leaseId: string | null, charge: number): void {
  const l = leaseId ? q.leases[leaseId] : undefined;
  if (l) l.used += charge;
}

export function closeLease(q: QuotaState, leaseId: string, holder: unknown, t: number): boolean {
  const l = q.leases[leaseId];
  if (!l) throw new QuotaError(404, "lease_unknown", "租约不存在或已过保留期");
  if (holder !== l.holder) throw new QuotaError(403, "lease_holder_mismatch", "租约不属于该网关实例");
  if (l.closed_at && !l.unreconciled) return false;
  l.closed_at = l.closed_at ?? new Date(t).toISOString();
  l.unreconciled = false;
  return true;
}

export function boostPct(q: QuotaState, ctx: QuotaCtx, pct: unknown, by: string | null): number {
  ensurePeriod(q, ctx);
  if (typeof pct !== "number" || !Number.isSafeInteger(pct) || pct < 1 || pct > MAX_BOOST_PCT) throw new QuotaError(400, "boost_invalid", `加量须为 1–${MAX_BOOST_PCT} 的整数百分比`);
  if (allowanceOf(ctx) <= 0) throw new QuotaError(409, "allowance_missing", "这家律所还没有套餐额度：先设套餐与席位");
  q.boosts.push({ at: new Date(ctx.t).toISOString(), pct, by });
  return Math.ceil((allowanceOf(ctx) * pct) / 100);
}

export function setCap(q: QuotaState, ctx: QuotaCtx, capPct: unknown, by: string | null): void {
  ensurePeriod(q, ctx);
  if (capPct !== null && !(typeof capPct === "number" && Number.isSafeInteger(capPct) && capPct >= 1 && capPct <= 100)) throw new QuotaError(400, "cap_invalid", "上限须为 1–100 的整数百分比，或不设上限");
  q.cap_pct = capPct as number | null;
  q.cap_set_at = new Date(ctx.t).toISOString();
  q.cap_set_by = by;
}

export function pausedOf(q: QuotaState, ctx: QuotaCtx): LimitedBy | null {
  const tot = totalsOf(q, ctx);
  const used = usedOf(q, ctx);
  if (tot.cap !== null && used >= tot.cap) return "cap";
  if (used >= tot.total) return "allowance";
  if (ctx.plan.burst && windowUsed(ctx, null) >= Math.floor((tot.total * ctx.plan.burst.pct) / 100)) return "burst";
  return null;
}

/** 按当前速度预计何时用完本期总额度（本期已过时间不足 1 天、或没有用量时不预测）。 */
export function forecastExhaust(q: QuotaState, ctx: QuotaCtx): string | null {
  const b = periodBounds(ctx.plan.period, ctx.t);
  const elapsed = ctx.t - Date.parse(b.start);
  const used = usedOf(q, ctx);
  const total = totalsOf(q, ctx).total;
  if (elapsed < 24 * 3600_000 || used <= 0) return null;
  if (used >= total) return new Date(ctx.t).toISOString();
  const at = ctx.t + ((total - used) / used) * elapsed;
  return at < Date.parse(b.resets_at) ? new Date(at).toISOString() : null;
}

/**
 * 律所侧（客户端）视图：百分比为主；管理员与合伙人另有用量与总额度（按对外单位）与按成员明细。
 */
export function quotaView(q: QuotaState, ctx: QuotaCtx, o: { detail: boolean; uid: string | null; sid: string | null; memberName: (uid: string) => string | null }) {
  ensurePeriod(q, ctx);
  sweepLeases(q, ctx.t);
  const unit = ctx.plan.quota_unit;
  const b = periodBounds(ctx.plan.period, ctx.t);
  const tot = totalsOf(q, ctx);
  const used = usedOf(q, ctx);
  const out = outstanding(q);
  const burst = ctx.plan.burst ? { hours: ctx.plan.burst.hours, pct: ctx.plan.burst.pct, used_ratio: ratio(windowUsed(ctx, null), Math.floor((tot.total * ctx.plan.burst.pct) / 100)), resets_at: ctx.book.windowResetAt(ctx.tid, null, ctx.plan.burst.hours, ctx.t) } : null;
  let own = null as null | Record<string, unknown>;
  if (o.uid) {
    const agg = ctx.book.member(ctx.tid, o.uid, q.period_from, q.period_to);
    const ml = memberLimitOf(ctx, o.uid);
    const denom = ml.limit ?? seatQuotaUnits(ctx.plan);
    const u = usedIn(unit, agg);
    own = { used_ratio: ratio(u, denom), denominator: ml.limit !== null ? ml.source : "seat_quota", enforced: ml.limit !== null, used: unitOut(unit, u), total: unitOut(unit, denom), requests: agg.requests, tokens: agg.tokens_in + agg.tokens_out, value_cny: agg.unpriced && !agg.value_micro ? null : Math.round(agg.value_micro / 100) / 10_000, estimated_rows: agg.estimated };
  }
  const models = [...ctx.book.group("model", ctx.tid, q.period_from, q.period_to)].map(([alias, a]) => ({ alias, used: unitOut(unit, usedIn(unit, a)), share: ratio(usedIn(unit, a), Math.max(1, usedIn(unit, ctx.book.tenant(ctx.tid, q.period_from, q.period_to)))), requests: a.requests })).sort((x, y) => y.share - x.share);
  return {
    unit,
    unit_label: unit === "tokens" ? "tokens" : "元",
    period: { kind: ctx.plan.period, key: q.period_key, start: b.start, resets_at: b.resets_at },
    firm: {
      used_ratio: ratio(used, tot.total),
      remaining_ratio: Math.max(0, ratio(tot.total - used, tot.total)),
      in_flight_ratio: ratio(out, tot.total),
      paused: pausedOf(q, ctx),
      cap_pct: q.cap_pct,
      cap_set_at: q.cap_set_at,
      boost_pct: tot.boost_pct,
      legacy_used_ratio: q.legacy && q.legacy.period_key === q.period_key ? q.legacy.used_ratio : null,
      used: o.detail ? unitOut(unit, used) : null,
      total: o.detail ? unitOut(unit, tot.total) : null,
      seats: ctx.seats,
      denominator: ctx.allowance_override !== null ? "custom_allowance" : "plan_seat_quota",
    },
    burst,
    own,
    history: q.history.map((h) => ({ period: h.period, used_ratio: h.used_ratio, legacy: h.legacy })),
    models,
    ...(o.detail
      ? {
          by_member: [...ctx.book.group("member", ctx.tid, q.period_from, q.period_to)]
            .map(([k, a]) => {
              const uid = k.split("\u0000")[1] || null;
              const u = usedIn(unit, a);
              return { uid, name: uid ? o.memberName(uid) : null, used: unitOut(unit, u), used_ratio_of_firm: ratio(u, tot.total), requests: a.requests };
            })
            .sort((x, y) => y.used_ratio_of_firm - x.used_ratio_of_firm),
          boosts: q.boosts.map((x) => ({ at: x.at, pct: x.pct })),
          unreconciled_leases: Object.values(q.leases).filter((l) => l.unreconciled).length,
        }
      : {}),
  };
}
