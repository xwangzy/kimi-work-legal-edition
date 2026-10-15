/**
 * 额度账本 v0（v9.2 §5.1 S3 计费与额度；调研 Y2 §3.3“额度池 + 消费上限 + 网关额度租约”）。
 *
 * - 每租户一个**额度池**（点数，运营开通或加量时注入）与律所管理员设的**月度消费上限**（硬停；null = 不设上限）；
 * - 网关不逐请求扣库：向账本**领取租约**（一段点数 + 到期时刻），本地扣减，定期按租约回报**累计**用量（按席位）；
 *   账本按“新累计 − 已记累计”入账，回报重发不会重复计费（幂等）；
 * - 可领取的点数 = min(池余额 − 在途租约未用部分, 本月上限 − 本月已用 − 在途租约未用部分)：上限最多被突破“在途租约里
 *   估算与实际的差额”（预占按估算、结算按实际），不会被并发请求成倍突破；
 * - 租约到期后网关不再从中支出；到期 + 宽限（30 分钟）仍未收到最终回报的租约按**已报用量**结案并标记“待对账”——
 *   计费以网关的预写计量日志为准（Y2 §3.3 三方对账），账本不按整段租约推定扣费；结案后 7 天内的迟到回报照常补记；
 * - 月份按北京时间自然月；跨月的租约，回报到达时记入当时所在的月份；
 * - **只有点数与席位编号**：不含任何请求内容、事项名称或匿名事项编号。
 *
 * 状态是普通 JSON（随控制面状态一并持久化，state-store.ts）。
 */
import { randomBytes } from "node:crypto";

export interface SeatUsage {
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

export interface QuotaState {
  /** 池余额（已扣除入账的用量；可因结算超出估算而为负，为负即不再发放租约）。 */
  pool: number;
  granted_total: number;
  cap_monthly: number | null;
  cap_set_at: string | null;
  /** 设上限的设备编号（审计用；运营设置为 null）。 */
  cap_set_by: string | null;
  /** 当前月份（北京时间，YYYY-MM）。 */
  period: string;
  period_used: number;
  period_by_seat: Record<string, SeatUsage>;
  /** 最近 12 个月的用量（不含当前月）。 */
  history: { period: string; used: number }[];
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
/** 单次租约点数上限（防止一次领走整池）。 */
export const LEASE_MAX_POINTS = 1_000_000;
/** 每租户同时在途的租约数上限（网关实例数 × 少量）。 */
export const MAX_OPEN_LEASES = 64;
/** 点数上限（整数，防止溢出与浮点误差）。 */
export const MAX_POINTS = 1e12;

const SID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const HOLDER_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** 北京时间自然月 YYYY-MM。 */
export function periodOf(t: number): string {
  const d = new Date(t + 8 * 3600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function emptyQuota(t: number): QuotaState {
  return { pool: 0, granted_total: 0, cap_monthly: null, cap_set_at: null, cap_set_by: null, period: periodOf(t), period_used: 0, period_by_seat: {}, history: [], leases: {} };
}

const isPoints = (n: unknown, allowZero = true): n is number => typeof n === "number" && Number.isSafeInteger(n) && (allowZero ? n >= 0 : n > 0) && n <= MAX_POINTS;

/** 跨月：当前月用量入历史、清零（每个入口先调用）。 */
export function rollPeriod(q: QuotaState, t: number): void {
  const p = periodOf(t);
  if (p === q.period) return;
  q.history = [...q.history, { period: q.period, used: q.period_used }].slice(-12);
  q.period = p;
  q.period_used = 0;
  q.period_by_seat = {};
}

/** 在途租约中尚未使用的点数（未结案且未到期；已到期的不能再支出，不计在途）。 */
export function outstanding(q: QuotaState, t: number): number {
  let s = 0;
  for (const l of Object.values(q.leases)) if (!l.closed_at && Date.parse(l.expires_at) > t) s += Math.max(0, l.points - l.used);
  return s;
}

/** 现在最多还能发放多少点（null 上限 = 只受池余额限制）。 */
export function available(q: QuotaState, t: number): number {
  const out = outstanding(q, t);
  const byPool = q.pool - out;
  const byCap = q.cap_monthly === null ? Number.POSITIVE_INFINITY : q.cap_monthly - q.period_used - out;
  return Math.max(0, Math.min(byPool, byCap));
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

export function grantPoints(q: QuotaState, points: number): void {
  if (!isPoints(points, false)) throw new QuotaError(400, "points_invalid", "加量点数须为正整数");
  if (q.pool + points > MAX_POINTS) throw new QuotaError(400, "points_invalid", "点数超出上限");
  q.pool += points;
  q.granted_total += points;
}

export function setCap(q: QuotaState, cap: unknown, t: number, by: string | null): void {
  if (cap !== null && !isPoints(cap)) throw new QuotaError(400, "cap_invalid", "月度上限须为非负整数点数，或不设上限");
  q.cap_monthly = cap as number | null;
  q.cap_set_at = new Date(t).toISOString();
  q.cap_set_by = by;
}

/** 发放租约：点数 = min(想要的, 可发放的, 单次上限)；一点都发不出即 402（区分上限与池余额）。 */
export function leaseQuota(q: QuotaState, input: { want: unknown; holder: unknown; ttl_ms?: unknown; need?: unknown }, t: number): LeaseRecord & { limited_by: "cap" | "pool" | null } {
  rollPeriod(q, t);
  sweepLeases(q, t);
  if (!isPoints(input.want, false)) throw new QuotaError(400, "want_invalid", "租约点数须为正整数");
  if (typeof input.holder !== "string" || !HOLDER_RE.test(input.holder)) throw new QuotaError(400, "holder_invalid", "网关实例标识不合法");
  const open = Object.values(q.leases).filter((l) => !l.closed_at).length;
  if (open >= MAX_OPEN_LEASES) throw new QuotaError(429, "too_many_leases", "在途租约过多");
  const avail = available(q, t);
  if (avail <= 0) {
    const capHit = q.cap_monthly !== null && q.cap_monthly - q.period_used - outstanding(q, t) <= 0;
    throw capHit ? new QuotaError(402, "cap_reached", "本所本月用量已达律所设定的上限") : new QuotaError(402, "pool_exhausted", "本所点数已用完");
  }
  const ttl = typeof input.ttl_ms === "number" && Number.isFinite(input.ttl_ms) ? Math.min(LEASE_MAX_TTL_MS, Math.max(10_000, Math.floor(input.ttl_ms))) : LEASE_TTL_MS;
  // 每次至多发剩余可发放的 1/4（但不少于本次请求所需 need）：多个网关实例时，一个实例不会一次领走全部剩余额度、让其他实例误报用完
  const need = isPoints(input.need, false) ? Math.min(input.need, input.want) : 1;
  const points = Math.min(input.want, avail, LEASE_MAX_POINTS, Math.max(need, Math.ceil(avail / 4)));
  // 发得比想要的少：告诉网关是上限还是池余额所限（网关据此对“单次预占超过剩余额度”的请求报对原因）
  const byCap = q.cap_monthly === null ? Number.POSITIVE_INFINITY : q.cap_monthly - q.period_used - outstanding(q, t);
  const limited_by = points < need ? (byCap <= q.pool - outstanding(q, t) ? "cap" : "pool") : null;
  const id = `ls_${randomBytes(12).toString("hex")}`;
  const l: LeaseRecord = { lease_id: id, holder: input.holder, points, granted_at: new Date(t).toISOString(), expires_at: new Date(t + ttl).toISOString(), by_seat: {}, used: 0, closed_at: null, unreconciled: false };
  q.leases[id] = l;
  return { ...l, limited_by };
}

/**
 * 租约回报（累计值，幂等）：每个席位的新累计减去已记累计即本次入账（累计变小的忽略）；`final` 表示网关不再从该租约支出。
 * 返回本次入账的点数。
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
    if (!r || typeof r.sid !== "string" || !SID_RE.test(r.sid) || !isPoints(r.points) || !isPoints(r.requests) || seen.has(r.sid)) throw new QuotaError(400, "usage_invalid", "用量回报不合法");
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
  q.pool -= charged;
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

/** 律所侧视图：本月用量、上限、最近月份；管理员与合伙人另含按成员的明细与池余额。 */
export function quotaView(q: QuotaState, t: number, o: { detail: boolean; seatOwner: (sid: string) => string | null; ownSid: string | null }) {
  rollPeriod(q, t);
  sweepLeases(q, t);
  const own = o.ownSid ? (q.period_by_seat[o.ownSid] ?? { points: 0, requests: 0 }) : null;
  return {
    period: q.period,
    cap_monthly: q.cap_monthly,
    cap_set_at: q.cap_set_at,
    period_used: q.period_used,
    /** 在途（已发放给网关、尚未用掉）的点数：上限判断已把它算进去。 */
    in_flight: outstanding(q, t),
    own,
    history: q.history,
    ...(o.detail
      ? {
          pool_remaining: q.pool,
          granted_total: q.granted_total,
          by_member: Object.entries(q.period_by_seat)
            .map(([sid, u]) => ({ member_id: o.seatOwner(sid), points: u.points, requests: u.requests }))
            .sort((a, b) => b.points - a.points),
          unreconciled_leases: Object.values(q.leases).filter((l) => l.unreconciled).length,
        }
      : {}),
  };
}
