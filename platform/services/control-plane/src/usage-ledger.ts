/**
 * 用量账本（第 44 批，主文 §4.2）：每个模型请求一行，只追加；**独立于控制面状态快照**（快照每次整份重写，放不下逐请求明细）。
 *
 * - 文件 `<dir>/YYYY-MM.jsonl`（北京时间月），每批先追加并 fsync 再应答网关；行里只有元数据与用量，不含请求内容、事项编号。
 * - 请求编号去重：启动时读当月与上月，重建去重集与聚合（按日、按成员、按模型、按小时）；网关重发同一请求编号只算一次。
 * - 额度、百分比、账单、控制台的用量页都从这里出，只有这一份数字。
 * - 规模：试点形态（每月百万行以内）全在内存；更大规模换成按行的数据库表（同一接口），见主文 §6。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface UsageTokens {
  /** 上游 prompt_tokens（含缓存命中与缓存写入）。 */
  input: number;
  /** 缓存命中。 */
  cached: number;
  /** 上游 completion_tokens（含推理）。 */
  output: number;
  reasoning: number;
  /** 第 62 批：缓存写入总数（prompt_tokens_details.cache_write_tokens；为 0 时不写这个字段）。 */
  cache_write?: number;
  /** 第 62 批：其中 1 小时 TTL 的写入（为 0 时不写）。 */
  cache_write_1h?: number;
}

/** 第 62 批：计费 token 明细（与 routing.ts BilledTokens 同形；四档互斥，相加 = prompt_tokens）。 */
export interface BilledRow {
  uncached: number;
  cached: number;
  cache_write_5m: number;
  cache_write_1h: number;
  output: number;
  reasoning: number;
}

export interface UsageRow {
  v: 1;
  request_id: string;
  client_request_id: string | null;
  upstream_request_id: string | null;
  at: string;
  started_at: string | null;
  /** 北京时间日 YYYY-MM-DD（聚合与分文件用）。 */
  day: string;
  tid: string;
  aid: string | null;
  uid: string | null;
  sid: string | null;
  dev: string | null;
  alias: string | null;
  provider: string | null;
  upstream_model: string | null;
  stream: boolean;
  qa: boolean;
  status: number | null;
  outcome: "ok" | "client_gone" | "upstream_error" | "timeout" | "blocked";
  usage: UsageTokens | null;
  usage_source: "upstream" | "drained" | "estimated" | "none";
  /** 本行扣额度时租户所用的单位与扣减量（tokens 为整数 token；cny 为微元）。 */
  unit: "tokens" | "cny";
  charge: number;
  value_micro: number | null;
  cost_micro: number | null;
  price_version: number | null;
  latency_ms: number | null;
  attempts: { provider: string | null; status: number | null; error: string | null; ms: number | null }[];
  finish_reason: string | null;
  lease_id: string | null;
  /** 第 44 批迁移：由升级前的网关预写日志补录（token 数是上游当时给的真实值，金额按补录时的价目表算）。 */
  backfill?: true;
  /**
   * 第 46 批（契约 §4）：流式中途中断（超时 / 上游流错误）且已向客户端写出内容。不扣额度、不计售价（usage 记 null、charge 与 value_micro 为 0），
   * 成本按网关估算的用量照算（cost_micro，对账“服务出错的已产生成本”）；估算用量放 partial_usage——旧版控制面读到这种行也不会把它算进额度。
   */
  partial?: true;
  partial_usage?: UsageTokens;
  /** 网关标注的重试（同一客户端请求编号的首个请求编号）；可选，只展示。 */
  retry_of?: string;
  /**
   * 第 62 批：计价追溯。price_basis = model 时 price_key 是实际服务的上游型号（kimi-k3.1-pro…），alias 时是别名（第 62 批之前的价目版本）；
   * billed 是计费 token 明细（未命中 / 命中 / 5 分钟写入 / 1 小时写入 / 输出 / 推理）；markup 是这一行适用的加价倍率。
   */
  price_basis?: "model" | "alias";
  price_key?: string;
  markup?: number | null;
  billed?: BilledRow;
  /**
   * 第 62 批：上游没给真实 usage（网关按已转发内容估算）——估算**不当作实测**：usage 记 null、不扣额度、不计售价与成本；
   * 估算的用量与按当时价目折的金额另记（est_*），标 reconcile = pending（待与上游账单对账）。第 46 批的 partial 行里按估算记的成本同此处理。
   */
  est_usage?: UsageTokens;
  est_value_micro?: number | null;
  est_cost_micro?: number | null;
  reconcile?: "pending";
}

export interface Agg {
  requests: number;
  tokens_in: number;
  tokens_cached: number;
  tokens_out: number;
  value_micro: number;
  cost_micro: number;
  errors: number;
  estimated: number;
  /** 有 usage 但售价未定价 / 成本价未定价的行数（这些行的金额不计入，界面标“未定价”）。 */
  unpriced: number;
  uncosted: number;
  /** 第 62 批：缓存写入 token（含 1 小时）。 */
  tokens_cache_write?: number;
  /** 第 62 批：待对账（估算用量）的行数与按估算折的售价、成本（微元；不计入 value_micro / cost_micro）。 */
  pending?: number;
  est_value_micro?: number;
  est_cost_micro?: number;
  /** 第 62 批：有成本价的行的售价合计（微元）——毛利只在“售价与成本都有”的行上算（价目生效前按售价定价、未填成本的行不计毛利）。 */
  costed_value_micro?: number;
}

export const emptyAgg = (): Agg => ({ requests: 0, tokens_in: 0, tokens_cached: 0, tokens_out: 0, value_micro: 0, cost_micro: 0, errors: 0, estimated: 0, unpriced: 0, uncosted: 0, tokens_cache_write: 0, pending: 0, est_value_micro: 0, est_cost_micro: 0, costed_value_micro: 0 });

export function addAgg(a: Agg, b: Agg): Agg {
  a.requests += b.requests;
  a.tokens_in += b.tokens_in;
  a.tokens_cached += b.tokens_cached;
  a.tokens_out += b.tokens_out;
  a.value_micro += b.value_micro;
  a.cost_micro += b.cost_micro;
  a.errors += b.errors;
  a.estimated += b.estimated;
  a.unpriced += b.unpriced;
  a.uncosted += b.uncosted;
  a.tokens_cache_write = (a.tokens_cache_write ?? 0) + (b.tokens_cache_write ?? 0);
  a.pending = (a.pending ?? 0) + (b.pending ?? 0);
  a.est_value_micro = (a.est_value_micro ?? 0) + (b.est_value_micro ?? 0);
  a.est_cost_micro = (a.est_cost_micro ?? 0) + (b.est_cost_micro ?? 0);
  a.costed_value_micro = (a.costed_value_micro ?? 0) + (b.costed_value_micro ?? 0);
  return a;
}

export function rowAgg(r: UsageRow): Agg {
  const u = r.usage;
  return {
    tokens_cache_write: u?.cache_write ?? 0,
    pending: r.reconcile === "pending" ? 1 : 0,
    est_value_micro: r.est_value_micro ?? 0,
    est_cost_micro: r.est_cost_micro ?? 0,
    costed_value_micro: r.cost_micro === null || r.cost_micro === undefined ? 0 : (r.value_micro ?? 0),
    requests: 1,
    tokens_in: u?.input ?? 0,
    tokens_cached: u?.cached ?? 0,
    tokens_out: u?.output ?? 0,
    value_micro: r.value_micro ?? 0,
    cost_micro: r.cost_micro ?? 0,
    errors: r.outcome === "upstream_error" || r.outcome === "timeout" ? 1 : 0,
    estimated: r.usage_source === "estimated" ? 1 : 0,
    unpriced: u && r.value_micro === null ? 1 : 0,
    uncosted: u && r.cost_micro === null ? 1 : 0,
  };
}

/** 按单位取“已用”：tokens = 输入 + 输出；cny = 售价金额（微元）。 */
export function usedIn(unit: "tokens" | "cny", a: Agg): number {
  return unit === "tokens" ? a.tokens_in + a.tokens_out : a.value_micro;
}

export const BJ_MS = 8 * 3600_000;
export function dayOf(t: number): string {
  return new Date(t + BJ_MS).toISOString().slice(0, 10);
}
export function monthOfDay(day: string): string {
  return day.slice(0, 7);
}
export const hourIndex = (t: number): number => Math.floor(t / 3600_000);

type DayMap = Map<string, Agg>;
const bump = <K>(m: Map<K, DayMap>, k: K, day: string, a: Agg) => {
  let d = m.get(k);
  if (!d) m.set(k, (d = new Map()));
  addAgg(d.get(day) ?? (d.set(day, emptyAgg()), d.get(day)!), a);
};

export interface UsageQuery {
  /** 第 66 批（V40）：只要这一时刻之前的行（ISO；个人用量明细翻页）。 */
  before?: string;
  from?: string;
  to?: string;
  tid?: string;
  aid?: string;
  /** 成员编号（第 47 批：律师本人的使用明细）。 */
  uid?: string;
  alias?: string;
  outcome?: string;
  request_id?: string;
  limit?: number;
  cursor?: string;
}

export class UsageBook {
  private readonly dir: string | null;
  private readonly seen = new Set<string>();
  /** 已载入的行（当月与上月，及之后追加的），按追加顺序。 */
  private readonly rows: UsageRow[] = [];
  private readonly byTenantDay = new Map<string, DayMap>();
  private readonly byMemberDay = new Map<string, DayMap>();
  private readonly byModelDay = new Map<string, DayMap>();
  /** 成员 × 模型（键：租户 \0 成员 \0 别名）。 */
  private readonly byMemberModelDay = new Map<string, DayMap>();
  /** 第 62 批：按实际服务的上游型号（键：租户 \0 上游型号）——成本按真实型号对账。 */
  private readonly byUpstreamDay = new Map<string, DayMap>();
  /** 小时桶：tid → 小时序号 → {tokens, value}；成员同理（滚动窗口用，保留 8 天）。 */
  private readonly hourT = new Map<string, Map<number, { tokens: number; value: number }>>();
  private readonly hourM = new Map<string, Map<number, { tokens: number; value: number }>>();
  readonly loadErrors: number;

  constructor(o: { dir?: string | null; now?: () => number } = {}) {
    this.dir = o.dir ?? null;
    let bad = 0;
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const t = (o.now ?? Date.now)();
      const cur = dayOf(t).slice(0, 7);
      const prevD = new Date(Date.UTC(Number(cur.slice(0, 4)), Number(cur.slice(5, 7)) - 2, 15));
      const prev = prevD.toISOString().slice(0, 7);
      for (const m of [prev, cur]) {
        const f = join(this.dir, `${m}.jsonl`);
        if (!existsSync(f)) continue;
        for (const line of readFileSync(f, "utf8").split("\n")) {
          if (!line) continue;
          try {
            const r = JSON.parse(line) as UsageRow;
            if (r && r.v === 1 && typeof r.request_id === "string" && !this.seen.has(r.request_id)) this.index(r);
          } catch {
            bad += 1;
          }
        }
      }
    }
    this.loadErrors = bad;
  }

  has(requestId: string): boolean {
    return this.seen.has(requestId);
  }

  /** 追加（同一批里同一请求编号只留第一条）；落盘失败抛错，内存不变。 */
  append(rows: UsageRow[]): UsageRow[] {
    const fresh: UsageRow[] = [];
    const ids = new Set<string>();
    for (const r of rows) if (!this.seen.has(r.request_id) && !ids.has(r.request_id)) (ids.add(r.request_id), fresh.push(r));
    if (fresh.length === 0) return fresh;
    if (this.dir) {
      const byMonth = new Map<string, string[]>();
      for (const r of fresh) byMonth.set(monthOfDay(r.day), [...(byMonth.get(monthOfDay(r.day)) ?? []), JSON.stringify(r)]);
      for (const [m, lines] of byMonth) {
        const fd = openSync(join(this.dir, `${m}.jsonl`), "a", 0o600);
        try {
          writeSync(fd, lines.join("\n") + "\n");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    }
    for (const r of fresh) this.index(r);
    return fresh;
  }

  private index(r: UsageRow): void {
    this.seen.add(r.request_id);
    this.rows.push(r);
    const a = rowAgg(r);
    bump(this.byTenantDay, r.tid, r.day, a);
    bump(this.byMemberDay, `${r.tid}\u0000${r.uid ?? ""}`, r.day, a);
    bump(this.byModelDay, `${r.tid}\u0000${r.alias ?? ""}`, r.day, a);
    bump(this.byMemberModelDay, `${r.tid}\u0000${r.uid ?? ""}\u0000${r.alias ?? ""}`, r.day, a);
    bump(this.byUpstreamDay, `${r.tid}\u0000${r.upstream_model ?? ""}`, r.day, a);
    const h = hourIndex(Date.parse(r.at));
    const tok = a.tokens_in + a.tokens_out;
    for (const [m, k] of [[this.hourT, r.tid], [this.hourM, `${r.tid}\u0000${r.uid ?? ""}`]] as const) {
      let x = m.get(k);
      if (!x) m.set(k, (x = new Map()));
      const c = x.get(h) ?? { tokens: 0, value: 0 };
      c.tokens += tok;
      c.value += a.value_micro;
      x.set(h, c);
      if (x.size > 200) for (const key of [...x.keys()].sort((p, q) => p - q).slice(0, x.size - 192)) x.delete(key);
    }
  }

  private sumMap(d: DayMap | undefined, from: string, to: string): Agg {
    const s = emptyAgg();
    if (!d) return s;
    for (const [day, a] of d) if (day >= from && day <= to) addAgg(s, a);
    return s;
  }

  tenant(tid: string, from: string, to: string): Agg {
    return this.sumMap(this.byTenantDay.get(tid), from, to);
  }
  member(tid: string, uid: string, from: string, to: string): Agg {
    return this.sumMap(this.byMemberDay.get(`${tid}\u0000${uid}`), from, to);
  }

  /** 最近 hours 小时内（含当前小时）的用量：滚动窗口。 */
  window(tid: string, uid: string | null, hours: number, t: number): { tokens: number; value: number } {
    const m = uid === null ? this.hourT.get(tid) : this.hourM.get(`${tid}\u0000${uid}`);
    const out = { tokens: 0, value: 0 };
    if (!m) return out;
    const end = hourIndex(t);
    for (const [h, c] of m) if (h > end - hours && h <= end) (out.tokens += c.tokens, out.value += c.value);
    return out;
  }

  /** 某小时桶最早何时滚出窗口（用于“频率窗口何时恢复”）：最早有用量的小时 + hours。 */
  windowResetAt(tid: string, uid: string | null, hours: number, t: number): string | null {
    const m = uid === null ? this.hourT.get(tid) : this.hourM.get(`${tid}\u0000${uid}`);
    if (!m) return null;
    const end = hourIndex(t);
    const hs = [...m.keys()].filter((h) => h > end - hours && h <= end).sort((a, b) => a - b);
    return hs.length ? new Date((hs[0]! + hours) * 3600_000).toISOString() : null;
  }

  daily(tid: string | null, from: string, to: string): Map<string, Agg> {
    const out = new Map<string, Agg>();
    const maps = tid === null ? [...this.byTenantDay.values()] : [this.byTenantDay.get(tid)].filter(Boolean) as DayMap[];
    for (const d of maps) for (const [day, a] of d) if (day >= from && day <= to) addAgg(out.get(day) ?? (out.set(day, emptyAgg()), out.get(day)!), a);
    return out;
  }

  /** 分组汇总：按模型 / 租户 / 成员（键里租户与成员用 \0 分隔）。 */
  group(kind: "model" | "tenant" | "member" | "upstream", tid: string | null, from: string, to: string): Map<string, Agg> {
    const src = kind === "tenant" ? this.byTenantDay : kind === "model" ? this.byModelDay : kind === "upstream" ? this.byUpstreamDay : this.byMemberDay;
    const out = new Map<string, Agg>();
    for (const [k, d] of src) {
      if (tid !== null && (kind === "tenant" ? k !== tid : !k.startsWith(`${tid}\u0000`))) continue;
      const key = kind === "tenant" ? k : kind === "model" || kind === "upstream" ? k.split("\u0000")[1]! : k;
      const s = this.sumMap(d, from, to);
      if (s.requests > 0) addAgg(out.get(key) ?? (out.set(key, emptyAgg()), out.get(key)!), s);
    }
    return out;
  }

  /** 某成员按模型汇总（键为别名）。 */
  memberModels(tid: string, uid: string, from: string, to: string): Map<string, Agg> {
    const out = new Map<string, Agg>();
    const prefix = `${tid}\u0000${uid}\u0000`;
    for (const [k, d] of this.byMemberModelDay) {
      if (!k.startsWith(prefix)) continue;
      const s = this.sumMap(d, from, to);
      if (s.requests > 0) out.set(k.slice(prefix.length), s);
    }
    return out;
  }

  /** 逐行查询（新的在前）；游标是“已载入行的序号”或“月份:行号”。 */
  query(q: UsageQuery): { rows: UsageRow[]; next: string | null } {
    const limit = Math.min(200, Math.max(1, q.limit ?? 50));
    const match = (r: UsageRow) =>
      (!q.from || r.day >= q.from) && (!q.to || r.day <= q.to) && (!q.before || r.at < q.before) && (!q.tid || r.tid === q.tid) && (!q.aid || r.aid === q.aid) && (!q.uid || r.uid === q.uid) && (!q.alias || r.alias === q.alias) && (!q.outcome || r.outcome === q.outcome) && (!q.request_id || r.request_id === q.request_id || r.client_request_id === q.request_id || r.upstream_request_id === q.request_id);
    const out: UsageRow[] = [];
    let i = q.cursor && /^\d{1,9}$/.test(q.cursor) ? Math.min(Number(q.cursor), this.rows.length) - 1 : this.rows.length - 1;
    for (; i >= 0 && out.length < limit; i--) if (match(this.rows[i]!)) out.push(this.rows[i]!);
    // 已载入的行之外（更早的月份）：按月份文件读
    if (out.length < limit && i < 0 && this.dir && q.from) {
      const loadedFrom = this.rows.length ? this.rows.reduce((m, r) => (r.day < m ? r.day : m), "9999") : "9999";
      if (q.from < loadedFrom) for (const r of this.readMonths(q.from, loadedFrom).reverse()) if (out.length < limit && match(r)) out.push(r);
    }
    return { rows: out, next: i >= 0 ? String(i + 1) : null };
  }

  /** 读指定日期范围内、未载入内存的月份文件（账单与导出用）。 */
  readMonths(from: string, toExclusive: string): UsageRow[] {
    if (!this.dir) return [];
    const out: UsageRow[] = [];
    const files = readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
    for (const f of files) {
      const m = f.slice(0, 7);
      if (m < from.slice(0, 7) || m > toExclusive.slice(0, 7)) continue;
      for (const line of readFileSync(join(this.dir, f), "utf8").split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as UsageRow;
          if (r.day >= from && r.day < toExclusive) out.push(r);
        } catch {
          // 坏行跳过
        }
      }
    }
    return out;
  }

  /** 日期范围内的全部行（已载入的走内存，更早的读月份文件；汇总里“价目生效前的行按现行价估算”用）。 */
  scan(from: string, to: string, pred: (r: UsageRow) => boolean): UsageRow[] {
    const out = this.rows.filter((r) => r.day >= from && r.day <= to && pred(r));
    const loadedFrom = this.rows.length ? this.rows.reduce((m, r) => (r.day < m ? r.day : m), "9999") : "9999";
    if (this.dir && from < loadedFrom) for (const r of this.readMonths(from, loadedFrom)) if (r.day <= to && pred(r)) out.push(r);
    return out;
  }

  /** 某月全部行（在内存就用内存，否则读文件）。 */
  monthRows(month: string): UsageRow[] {
    const mem = this.rows.filter((r) => r.day.startsWith(month));
    if (mem.length || !this.dir) return mem;
    return this.readMonths(`${month}-01`, `${month}-32`);
  }

  get size(): number {
    return this.rows.length;
  }
}
