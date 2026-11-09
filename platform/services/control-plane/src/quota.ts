/**
 * 额度账本 v1（第 40 批：取消“点数”，改为**本月额度的百分比**；v9.2 §5.1 S3 计费与额度、调研 Y2 §3.3 网关额度租约）。
 *
 * 第一性原理：律所买的是“每个席位每月一份 AI 额度”（套餐），律师关心的只是“这个月用了多少、还剩多少”——
 * 所以对外只说**百分比**（与 Kimi 会员额度同一表达：used_ratio，到 100% 暂停、下月 1 日重置或加量）。
 *
 * - **本月总额度** = 套餐额度（席位数 × 套餐每席位月额度，由控制面按套餐目录写入 allowance）+ 本月加量（boost，跨月清零）；
 * - **加量包**按套餐额度的百分比购买（+25% / +50% / +100% …），记入 boosts（计费依据），跨月清零；
 * - **月度上限**由律所管理员设，为本月总额度的百分比（1–100；null = 不设，即到 100% 才停）；运营代设只能调低；
 * - 计量单位（unit）是网关按 token 折算的内部整数（`legal/k3` 每千 token 4 个单位），只在账本、网关与对账里出现，
 *   **不在任何界面上作为“点数”出现**；对外视图只给比例（0–1，保留 4 位小数）；
 * - 网关不逐请求扣库：向账本**领取租约**（一段单位 + 到期时刻），本地扣减，定期按租约回报**累计**用量（按席位）；
 *   账本按“新累计 − 已记累计”入账，回报重发不会重复计费（幂等）；
 * - 可领取的单位 = min(本月剩余 − 在途, 上限 − 本月已用 − 在途)；**在途**包括已到期但尚未收到最终回报、仍在宽限期内的租约
 *   （复核 S9A-04）；上限最多被突破“预占估算与实际用量之差”；调低上限对已发出的租约几分钟后生效；
 * - 租约到期 + 宽限（30 分钟）仍未收到最终回报的按**已报用量**结案并标记“待对账”（计费以网关预写计量日志为准）；
 *   结案后 7 天内的迟到回报照常补记；
 * - 月份按北京时间自然月；跨月的租约，回报到达时记入当时所在的月份；
 * - **只有用量、席位编号与请求次数**：不含任何请求内容、事项名称或匿名事项编号。
 *
 * 线上协议不变（网关 ↔ 控制面的 lease/settle 字段仍叫 points、limited_by 仍为 "cap" | "pool"，"pool" 即“本月额度用完”），
 * 已部署的网关不用随本批升级。状态是普通 JSON（随控制面状态一并持久化，state-store.ts）。
 */
import { randomBytes } from "node:crypto";

export interface SeatUsage {
  /** 计量单位（内部）。线上回报字段名沿用 points。 */
  points: number;
  requests: number;
}

export interface LeaseRecord {
  lease_id: string;
  /** 领取的网关实例（服务间凭据之下的自报标识，只用于对账）。 */
  holder: string;
  points: number;
  granted_at: string;
  expires_at: string;
  /** 已入账的累计用量（按席位）。 */
  by_seat: Record<string, SeatUsage>;
  used: number;
  closed_at: string | null;
  /** 到期宽限后仍未收到最终回报：按已报用量结案，待与网关计量日志对账。 */
  unreconciled: boolean;
}

/** 一次加量（计费依据）：百分比（相对套餐额度）、折合单位、时刻与执行者（运营编号；进程内为 null）。 */
export interface BoostRecord {
  at: string;
  pct: number;
  units: number;
  by: string | null;
}

/** 历史月份：用量、当月总额度与加量百分比（v0 的历史没有 total，读回为 null，界面显示“—”）。 */
export interface QuotaHistoryRow {
  period: string;
  used: number;
  total: number | null;
  boost_pct: number;
}

export interface QuotaState {
  /** 本月套餐额度（单位）：席位数 × 套餐每席位月额度；由控制面在开通、改套餐、改席位时写入（syncAllowance）。 */
  allowance: number;
  /** 本月加量（单位；跨月清零）。 */
  boost: number;
  boosts: BoostRecord[];
  /** 律所设的月度上限：本月总额度的百分比（1–100）；null = 不设上限。 */
  cap_pct: number | null;
  cap_set_at: string | null;
  /** 设上限的设备编号或运营编号（审计用；进程内运维为 null）。 */
  cap_set_by: string | null;
  /** 当前月份（北京时间，YYYY-MM）。 */
  period: string;
  period_used: number;
  period_by_seat: Record<string, SeatUsage>;
  /** 最近 12 个月（不含当前月）。 */
  history: QuotaHistoryRow[];
  leases: Record<string, LeaseRecord>;
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

/** 租约有效期缺省与上限。 */
export const LEASE_TTL_MS = 5 * 60_000;
export const LEASE_MAX_TTL_MS = 30 * 60_000;
/** 到期后等待最终回报的宽限。 */
export const LEASE_GRACE_MS = 30 * 60_000;
/** 结案后仍接受迟到回报的时长。 */
export const LEASE_KEEP_MS = 7 * 24 * 3600_000;
/** 单次租约单位上限（防止一次领走整月额度）。 */
export const LEASE_MAX_POINTS = 1_000_000;
/** 每租户同时在途的租约数上限（网关实例数 × 少量）。 */
export const MAX_OPEN_LEASES = 64;
/** 单位上限（整数，防止溢出与浮点误差）。 */
export const MAX_POINTS = 1e12;
/** 单次加量百分比上限（相对套餐额度）。 */
export const MAX_BOOST_PCT = 1000;

const SID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const HOLDER_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** 北京时间自然月 YYYY-MM。 */
export function periodOf(t: number): string {
  const d = new Date(t + 8 * 3600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 下一个北京时间自然月的 1 日 0 点（UTC ISO）：额度重置时刻。 */
export function periodResetAt(t: number): string {
  const d = new Date(t + 8 * 3600_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 8 * 3600_000).toISOString();
}

export function emptyQuota(t: number, allowance = 0): QuotaState {
  return { allowance, boost: 0, boosts: [], cap_pct: null, cap_set_at: null, cap_set_by: null, period: periodOf(t), period_used: 0, period_by_seat: {}, history: [], leases: {} };
}

/**
 * 读回旧状态（第 9～39 批的“点数池”账本）：池余额与累计注入不再有意义（改为按月额度）；月度上限是点数，无法换成百分比——
 * 一律按“不设上限”读回（律所管理员在客户端重新设百分比上限）。历史月份保留用量，总额度记 null。
 */
export function migrateQuota(raw: unknown, t: number): QuotaState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const q = emptyQuota(t);
  if (typeof r.period === "string") q.period = r.period;
  if (Number.isSafeInteger(r.period_used)) q.period_used = r.period_used;
  if (r.period_by_seat && typeof r.period_by_seat === "object") q.period_by_seat = r.period_by_seat;
  if (r.leases && typeof r.leases === "object") q.leases = r.leases;
  if (Array.isArray(r.history)) q.history = r.history.map((h: any) => ({ period: String(h.period), used: Number(h.used) || 0, total: Number.isSafeInteger(h.total) ? h.total : null, boost_pct: Number(h.boost_pct) || 0 }));
  if (Number.isSafeInteger(r.allowance)) q.allowance = r.allowance;
  if (Number.isSafeInteger(r.boost)) q.boost = r.boost;
  if (Array.isArray(r.boosts)) q.boosts = r.boosts;
  if (r.cap_pct === null || (Number.isSafeInteger(r.cap_pct) && r.cap_pct >= 1 && r.cap_pct <= 100)) {
    q.cap_pct = r.cap_pct ?? null;
    q.cap_set_at = typeof r.cap_set_at === "string" ? r.cap_set_at : null;
    q.cap_set_by = typeof r.cap_set_by === "string" ? r.cap_set_by : null;
  }
  return q;
}

const isUnits = (n: unknown, allowZero = true): n is number => typeof n === "number" && Number.isSafeInteger(n) && (allowZero ? n >= 0 : n > 0) && n <= MAX_POINTS;

/** 本月总额度（单位）= 套餐额度 + 本月加量。 */
export function totalOf(q: QuotaState): number {
  return q.allowance + q.boost;
}

/** 上限折合单位（不设上限为 null）。 */
export function capUnits(q: QuotaState): number | null {
  return q.cap_pct === null ? null : Math.floor((totalOf(q) * q.cap_pct) / 100);
}

/** 比例（保留 4 位小数；分母为 0 时：分子 > 0 视为 1，否则 0）。 */
export function ratio(n: number, d: number): number {
  if (d <= 0) return n > 0 ? 1 : 0;
  return Math.round((n / d) * 10_000) / 10_000;
}

/** 跨月：当前月用量入历史、清零；加量跨月清零（每个入口先调用）。 */
export function rollPeriod(q: QuotaState, t: number): void {
  const p = periodOf(t);
  if (p === q.period) return;
  // 中间没有活动的月份补 0（复核 S9A-17：界面“最近月份”不跳月）
  const gap: QuotaHistoryRow[] = [];
  for (let [y, m] = q.period.split("-").map(Number) as [number, number]; ; ) {
    m += 1;
    if (m > 12) [y, m] = [y + 1, 1];
    const k = `${y}-${String(m).padStart(2, "0")}`;
    if (k >= p || gap.length >= 12) break;
    gap.push({ period: k, used: 0, total: q.allowance, boost_pct: 0 });
  }
  const boostPct = q.boosts.reduce((s, b) => s + b.pct, 0);
  q.history = [...q.history, { period: q.period, used: q.period_used, total: totalOf(q), boost_pct: boostPct }, ...gap].slice(-12);
  q.period = p;
  q.period_used = 0;
  q.period_by_seat = {};
  q.boost = 0;
  q.boosts = [];
}

/** 套餐额度变更（开通、改套餐、改席位）：立即对本月生效（已用不变，百分比随之重算）。 */
export function syncAllowance(q: QuotaState, allowance: number, t: number): void {
  rollPeriod(q, t);
  if (!isUnits(allowance)) throw new QuotaError(400, "allowance_invalid", "套餐额度不合法");
  q.allowance = allowance;
}

/**
 * 在途租约中尚未入账的单位：未结案的租约都算（含已到期、仍在宽限期内的；复核 S9A-04）。收到最终回报或宽限期满结案后释放。
 */
export function outstanding(q: QuotaState, _t: number): number {
  let s = 0;
  for (const l of Object.values(q.leases)) if (!l.closed_at) s += Math.max(0, l.points - l.used);
  return s;
}

/** 现在最多还能发放多少单位。 */
export function available(q: QuotaState, t: number): number {
  const out = outstanding(q, t);
  const byTotal = totalOf(q) - q.period_used - out;
  const cap = capUnits(q);
  const byCap = cap === null ? Number.POSITIVE_INFINITY : cap - q.period_used - out;
  return Math.max(0, Math.min(byTotal, byCap));
}

/** 到期 + 宽限仍未结案的租约按已报用量结案（标记待对账）；结案超过保留期的删除。 */
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

/** 按单位加量（内部与用例；对外的加量一律按百分比，见 boostPct）。 */
export function grantUnits(q: QuotaState, units: number, t: number = Date.now(), by: string | null = null, pct = 0): void {
  rollPeriod(q, t);
  if (!isUnits(units, false)) throw new QuotaError(400, "boost_invalid", "加量须为正整数");
  if (q.boost + units > MAX_POINTS) throw new QuotaError(400, "boost_invalid", "加量超出上限");
  q.boost += units;
  q.boosts.push({ at: new Date(t).toISOString(), pct, units, by });
}

/** 加量包：按**套餐额度**的百分比（1–1000）加到本月；跨月清零。返回折合的单位。 */
export function boostPct(q: QuotaState, pct: unknown, t: number, by: string | null): number {
  rollPeriod(q, t);
  if (typeof pct !== "number" || !Number.isSafeInteger(pct) || pct < 1 || pct > MAX_BOOST_PCT) throw new QuotaError(400, "boost_invalid", `加量须为 1–${MAX_BOOST_PCT} 的整数百分比`);
  if (q.allowance <= 0) throw new QuotaError(409, "allowance_missing", "这家律所还没有套餐额度：先设套餐与席位");
  const units = Math.ceil((q.allowance * pct) / 100);
  grantUnits(q, units, t, by, pct);
  return units;
}

/** 设月度上限：本月总额度的百分比（1–100 的整数），null = 不设上限。 */
export function setCap(q: QuotaState, capPct: unknown, t: number, by: string | null): void {
  rollPeriod(q, t);
  if (capPct !== null && !(typeof capPct === "number" && Number.isSafeInteger(capPct) && capPct >= 1 && capPct <= 100)) throw new QuotaError(400, "cap_invalid", "月度上限须为 1–100 的整数百分比，或不设上限");
  q.cap_pct = capPct as number | null;
  q.cap_set_at = new Date(t).toISOString();
  q.cap_set_by = by;
}

/** 暂停原因：上限已到 / 本月额度用完（100%）。 */
export function pausedOf(q: QuotaState): "cap" | "allowance" | null {
  const cap = capUnits(q);
  if (cap !== null && q.period_used >= cap) return "cap";
  if (q.period_used >= totalOf(q)) return "allowance";
  return null;
}

/** 发放租约：单位 = min(想要的, 可发放的, 单次上限)；一个都发不出即 402（区分上限与本月额度）。 */
export function leaseQuota(q: QuotaState, input: { want: unknown; holder: unknown; ttl_ms?: unknown; need?: unknown }, t: number): LeaseRecord & { limited_by: "cap" | "pool" | null } {
  rollPeriod(q, t);
  sweepLeases(q, t);
  if (!isUnits(input.want, false)) throw new QuotaError(400, "want_invalid", "租约单位须为正整数");
  if (typeof input.holder !== "string" || !HOLDER_RE.test(input.holder)) throw new QuotaError(400, "holder_invalid", "网关实例标识不合法");
  const open = Object.values(q.leases).filter((l) => !l.closed_at).length;
  if (open >= MAX_OPEN_LEASES) throw new QuotaError(429, "too_many_leases", "在途租约过多");
  const out = outstanding(q, t);
  const cap = capUnits(q);
  const byCap = cap === null ? Number.POSITIVE_INFINITY : cap - q.period_used - out;
  const byTotal = totalOf(q) - q.period_used - out;
  const avail = Math.max(0, Math.min(byTotal, byCap));
  if (avail <= 0) throw byCap <= 0 ? new QuotaError(402, "cap_reached", "本所本月用量已达律所设定的上限") : new QuotaError(402, "pool_exhausted", "本所本月 AI 额度已用完（100%）");
  const ttl = typeof input.ttl_ms === "number" && Number.isFinite(input.ttl_ms) ? Math.min(LEASE_MAX_TTL_MS, Math.max(10_000, Math.floor(input.ttl_ms))) : LEASE_TTL_MS;
  // 每次至多发剩余可发放的 1/4（但不少于本次请求所需 need）：多个网关实例时，一个实例不会一次领走全部剩余额度、让其他实例误报用完
  const need = isUnits(input.need, false) ? Math.min(input.need, input.want) : 1;
  const points = Math.min(input.want, avail, LEASE_MAX_POINTS, Math.max(need, Math.ceil(avail / 4)));
  // 发得比想要的少：告诉网关是上限还是本月额度所限（线上字段 "pool" 即本月额度）
  const limited_by = points < need ? (byCap <= byTotal ? "cap" : "pool") : null;
  const id = `ls_${randomBytes(12).toString("hex")}`;
  const l: LeaseRecord = { lease_id: id, holder: input.holder, points, granted_at: new Date(t).toISOString(), expires_at: new Date(t + ttl).toISOString(), by_seat: {}, used: 0, closed_at: null, unreconciled: false };
  q.leases[id] = l;
  return { ...l, limited_by };
}

/**
 * 租约回报（累计值，幂等）：每个席位的新累计减去已记累计即本次入账（累计变小的忽略）；`final` 表示网关不再从该租约支出。
 * 返回本次入账的单位。
 */
export function settleLease(q: QuotaState, input: { lease_id: unknown; holder: unknown; usage: unknown; final?: unknown }, t: number): { charged: number; closed: boolean } {
  rollPeriod(q, t);
  sweepLeases(q, t);
  const id = typeof input.lease_id === "string" ? input.lease_id : "";
  const l = q.leases[id];
  if (!l) throw new QuotaError(404, "lease_unknown", "租约不存在或已过保留期");
  if (input.holder !== l.holder) throw new QuotaError(403, "lease_holder_mismatch", "租约不属于该网关实例");
  if (!Array.isArray(input.usage) || input.usage.length > 10_000) throw new QuotaError(400, "usage_invalid", "用量回报不合法");
  // 先整体校验再入账（不合法的回报不留下半截入账）
  const rows: { sid: string; points: number; requests: number }[] = [];
  const seen = new Set<string>();
  for (const u of input.usage as unknown[]) {
    const r = u as Record<string, unknown> | null;
    if (!r || typeof r.sid !== "string" || !SID_RE.test(r.sid) || !isUnits(r.points) || !isUnits(r.requests) || seen.has(r.sid)) throw new QuotaError(400, "usage_invalid", "用量回报不合法");
    seen.add(r.sid);
    rows.push({ sid: r.sid, points: r.points, requests: r.requests });
  }
  let charged = 0;
  for (const r of rows) {
    const prev = l.by_seat[r.sid] ?? { points: 0, requests: 0 };
    const dp = Math.max(0, r.points - prev.points);
    const dr = Math.max(0, r.requests - prev.requests);
    if (dp === 0 && dr === 0) continue;
    l.by_seat[r.sid] = { points: Math.max(prev.points, r.points), requests: Math.max(prev.requests, r.requests) };
    const ps = q.period_by_seat[r.sid] ?? { points: 0, requests: 0 };
    q.period_by_seat[r.sid] = { points: ps.points + dp, requests: ps.requests + dr };
    charged += dp;
  }
  l.used += charged;
  q.period_used += charged;
  let closed = false;
  if (input.final === true && !l.closed_at) {
    l.closed_at = new Date(t).toISOString();
    closed = true;
  }
  // 迟到的最终回报把“待对账”消掉（已按实际累计补记）
  if (input.final === true && l.unreconciled) l.unreconciled = false;
  return { charged, closed };
}

/**
 * 律所侧视图（只有比例，没有单位）：本所本月已用占本月总额度、上限百分比、加量百分比、重置时刻、自己占个人份额的比例；
 * 管理员与合伙人另含按成员明细（占个人份额、占全所）。个人份额 = 本月总额度 ÷ 席位数（只用于显示，不单独限额）。
 */
export function quotaView(q: QuotaState, t: number, o: { detail: boolean; seats: number; seatOwner: (sid: string) => string | null; ownSid: string | null }) {
  rollPeriod(q, t);
  sweepLeases(q, t);
  const total = totalOf(q);
  const share = o.seats > 0 ? total / o.seats : total;
  const ownU = o.ownSid ? (q.period_by_seat[o.ownSid] ?? { points: 0, requests: 0 }) : null;
  const out = outstanding(q, t);
  return {
    period: q.period,
    resets_at: periodResetAt(t),
    paused: pausedOf(q),
    used_ratio: ratio(q.period_used, total),
    /** 已发给网关、尚未结算的部分占本月总额度（上限判断已把它算进去）。 */
    in_flight_ratio: ratio(out, total),
    cap_pct: q.cap_pct,
    cap_set_at: q.cap_set_at,
    /** 本月加量合计（相对套餐额度的百分比）。 */
    boost_pct: q.boosts.reduce((s, b) => s + b.pct, 0),
    seats: o.seats,
    own: ownU ? { used_ratio: ratio(ownU.points, share), firm_ratio: ratio(ownU.points, total), requests: ownU.requests } : null,
    history: q.history.map((h) => ({ period: h.period, used_ratio: h.total === null ? null : ratio(h.used, h.total), boost_pct: h.boost_pct })),
    ...(o.detail
      ? {
          by_member: Object.entries(q.period_by_seat)
            .map(([sid, u]) => ({ member_id: o.seatOwner(sid), used_ratio: ratio(u.points, share), firm_ratio: ratio(u.points, total), requests: u.requests }))
            .sort((a, b) => b.firm_ratio - a.firm_ratio),
          boosts: q.boosts.map((b) => ({ at: b.at, pct: b.pct })),
          unreconciled_leases: Object.values(q.leases).filter((l) => l.unreconciled).length,
        }
      : {}),
  };
}
