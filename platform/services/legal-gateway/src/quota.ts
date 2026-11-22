/**
 * 网关的额度来源（v9.2 §5.1 S3；V19 第 44 批额度租约 v2，主文 §4.3）。
 *
 * - `MapQuota`：内存余额（开发、试用版本机网关与既有用例），单位缺省 tokens；
 * - `LeaseQuota`：向控制面额度账本**按席位**领租约（键 `${tid}|${sid}`）：`POST /v1/quota/lease` → `{lease_id, unit, units, expires_at,
 *   limited_by, price_version, allowed_aliases}`。每次预占从一份**未到期、余量够**的租约里扣；结算时按本请求的 charge_units 修正余量，
 *   并把整条 UsageRecord 排进待回报队列；每 15 秒或攒够 100 条 `POST /v1/quota/settle {tid, lease_id, holder, records, final}`。
 *   控制面按 request_id 去重，所以重发安全。
 * - 发件箱：meter.jsonl 是预写日志（settle 行带完整 UsageRecord）；`meter.ack` 记已确认送达的字节偏移（原子改名写）。
 *   启动时从检查点重放未确认的 settle 行；`close()` 做最终回报（cloud-serve 停机钩子里 await，限时 5 秒）。
 * - 账本不可达：已有租约照常用到期；之后预占失败（`quota_unavailable`，503），不发往上游。
 * - 只有单位数、编号与 token 数；不含请求内容。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { cleanUsageRecord, type QuotaUnit, type UsageRecord } from "./usage.ts";

/** meter.jsonl 里一行的字节范围（发件箱检查点用）。 */
export interface MeterPos {
  start: number;
  end: number;
}

export interface ReserveRequest {
  tid: string;
  sid: string;
  alias: string;
  /** 预估 token（输入、输出）。 */
  estimate: { input: number; output: number };
}

/** 把预估折成某种单位；null = 该单位下本别名无法计价（cny 而未定价）。 */
export type UnitPricer = (unit: QuotaUnit) => number | null;

export interface QuotaHold {
  readonly tid: string;
  readonly sid: string;
  readonly unit: QuotaUnit;
  /** 预占的单位数。 */
  readonly units: number;
  /** LeaseQuota：出自哪份租约。 */
  readonly leaseId?: string;
  readonly priceVersion?: string | number | null;
}

export type ReserveResult = { ok: true; hold: QuotaHold } | { ok: false; status: number; code: string; message: string };

export interface QuotaSource {
  /** 原子预占（检查与扣减不被其他请求插入）。 */
  reserve(req: ReserveRequest, price: UnitPricer): Promise<ReserveResult>;
  /** 未发往上游即退还。 */
  refund(hold: QuotaHold): void;
  /** 结算：退还预占、扣 record.charge_units；LeaseQuota 另把记录排进回报队列（pos = 该记录在 meter.jsonl 里的位置）。 */
  settle(hold: QuotaHold, record: UsageRecord, pos?: MeterPos | null): void;
}

const PRICE_UNCONFIGURED: ReserveResult = { ok: false, status: 503, code: "price_unconfigured", message: "该模型尚未定价，暂不能使用：请联系平台运营" };

/** 内存余额（与第 9 批之前的 `budgets` 行为一致；单位缺省 tokens）。 */
export class MapQuota implements QuotaSource {
  readonly budgets: Map<string, number>;
  readonly unit: QuotaUnit;
  constructor(budgets: Map<string, number>, unit: QuotaUnit = "tokens") {
    this.budgets = budgets;
    this.unit = unit;
  }
  async reserve(req: ReserveRequest, price: UnitPricer): Promise<ReserveResult> {
    const units = price(this.unit);
    if (units === null) return PRICE_UNCONFIGURED;
    const left = this.budgets.get(req.tid) ?? 0;
    if (left < units) return { ok: false, status: 402, code: "quota_exhausted", message: "本所本期 AI 额度不足（预占失败）" };
    this.budgets.set(req.tid, left - units);
    return { ok: true, hold: { tid: req.tid, sid: req.sid, unit: this.unit, units } };
  }
  refund(hold: QuotaHold): void {
    this.budgets.set(hold.tid, (this.budgets.get(hold.tid) ?? 0) + hold.units);
  }
  settle(hold: QuotaHold, record: UsageRecord): void {
    this.budgets.set(hold.tid, (this.budgets.get(hold.tid) ?? 0) + hold.units - record.charge_units);
  }
}

export type LimitedBy = null | "cap" | "allowance" | "burst" | "seat";

export interface LeaseGrant {
  lease_id: string;
  unit: QuotaUnit;
  units: number;
  expires_at: string;
  limited_by: LimitedBy;
  price_version: string | number | null;
  allowed_aliases: string[] | null;
}

export interface LeaseRequestBody {
  tid: string;
  sid: string;
  holder: string;
  need_estimate: { alias: string; input: number; output: number };
  want?: number;
  ttl_ms?: number;
}

export interface SettleBody {
  tid: string;
  lease_id: string;
  holder: string;
  records: UsageRecord[];
  final: boolean;
}

export type LedgerFailure = { ok: false; status: number; code: string; message?: string };

export interface LedgerClient {
  lease(body: LeaseRequestBody): Promise<({ ok: true } & LeaseGrant) | LedgerFailure>;
  settle(body: SettleBody): Promise<{ ok: true; accepted: number; duplicates: number; closed: boolean; /** 第 56 批：控制面已收回这份租约（额度收紧）。 */ revoked?: boolean } | LedgerFailure>;
}

const CODE_RE = /^[a-z0-9_]{1,48}$/;
const cleanMessage = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : undefined);
const LIMITED: readonly LimitedBy[] = [null, "cap", "allowance", "burst", "seat"];

/** 经 HTTP 访问控制面额度账本（服务间凭据）。 */
export function httpLedger(o: { baseUrl: string; serviceSecret: string; fetchImpl?: typeof fetch; timeoutMs?: number }): LedgerClient {
  const call = async (path: string, body: unknown): Promise<{ ok: true; json: any } | LedgerFailure> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 5_000);
    try {
      const r = await (o.fetchImpl ?? fetch)(`${o.baseUrl.replace(/\/+$/, "")}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${o.serviceSecret}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: ac.signal,
      });
      const json = (await r.json().catch(() => ({}))) as any;
      if (!r.ok) {
        const code = String(json?.error?.code ?? "");
        const message = cleanMessage(json?.error?.message);
        return { ok: false, status: r.status, code: CODE_RE.test(code) ? code : `http_${r.status}`, ...(message ? { message } : {}) };
      }
      return { ok: true, json };
    } catch {
      return { ok: false, status: 0, code: "ledger_unreachable" };
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async lease(body) {
      const r = await call("/v1/quota/lease", body);
      if (!r.ok) return r;
      const j = r.json ?? {};
      const unit = j.unit;
      const aliases = j.allowed_aliases;
      if (
        typeof j.lease_id !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,96}$/.test(j.lease_id) ||
        (unit !== "tokens" && unit !== "cny") ||
        !Number.isSafeInteger(j.units) ||
        j.units <= 0 ||
        !Number.isFinite(Date.parse(String(j.expires_at))) ||
        !(aliases === null || aliases === undefined || (Array.isArray(aliases) && aliases.every((a: unknown) => typeof a === "string")))
      )
        return { ok: false, status: 502, code: "ledger_reply_invalid" };
      return {
        ok: true,
        lease_id: j.lease_id,
        unit,
        units: j.units,
        expires_at: String(j.expires_at),
        limited_by: LIMITED.includes(j.limited_by) ? j.limited_by : null,
        price_version: typeof j.price_version === "number" || typeof j.price_version === "string" ? j.price_version : null,
        allowed_aliases: Array.isArray(aliases) ? aliases : null,
      };
    },
    async settle(body) {
      const r = await call("/v1/quota/settle", body);
      if (!r.ok) return r;
      const j = r.json ?? {};
      return { ok: true, accepted: Number(j.accepted) || 0, duplicates: Number(j.duplicates) || 0, closed: j.closed === true, ...(j.revoked === true ? { revoked: true } : {}) };
    },
  };
}

interface LocalLease {
  id: string;
  key: string;
  tid: string;
  sid: string;
  unit: QuotaUnit;
  units: number;
  expiresAt: number;
  /** 余量（预占减、结算按实际修正；可为负 = 实际超出估算）。 */
  remaining: number;
  /** 在途预占数。 */
  holds: number;
  priceVersion: string | number | null;
  allowedAliases: ReadonlySet<string> | null;
}

/** 待回报的一条（发件箱）。 */
export interface OutboxItem {
  rec: UsageRecord;
  leaseId: string;
  tid: string;
  holder: string;
  pos: MeterPos | null;
}

export interface LeaseQuotaOptions {
  ledger: LedgerClient;
  /** 本网关实例标识（[A-Za-z0-9_.-]）；cloud-serve 用 `gw-<hostname>-<pid>-<随机 6 位>`。 */
  holder: string;
  /** 回报周期（缺省 15 秒）。 */
  flushMs?: number;
  /** 攒够这么多条即回报（缺省 100；也是每次 settle 的条数上限）。 */
  batchSize?: number;
  /** 离到期不足这么久的租约不再用于新的预占（缺省 5 秒：避免请求进行中租约过期）。 */
  expiryMarginMs?: number;
  /** 未到期租约的总余量低于“最近一份租约 × 此比例”即后台预取（缺省 0.3）。 */
  lowWaterRatio?: number;
  /** 发件箱：meter.jsonl 与检查点 meter.ack（给出即启动时重放未确认的 settle 行）。 */
  outbox?: { meterFile: string; ackFile: string };
  now?: () => number;
  /** 兼容旧参数（第 44 批起由控制面决定每份租约的大小，不再使用）。 */
  leaseSize?: number;
}

/** 读检查点（不存在或损坏 = 0）。 */
export function readAck(ackFile: string): number {
  try {
    const j = JSON.parse(readFileSync(ackFile, "utf8")) as { offset?: unknown };
    return Number.isSafeInteger(j.offset) && (j.offset as number) >= 0 ? (j.offset as number) : 0;
  } catch {
    return 0;
  }
}

/** 原子写检查点（先写临时文件再改名）。 */
export function writeAck(ackFile: string, offset: number): void {
  const tmp = `${ackFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ offset, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  renameSync(tmp, ackFile);
}

/**
 * 扫 meter.jsonl 从 `from` 到文件尾的完整行，取出带 UsageRecord 的 settle 行（分块读，不整文件进内存）。
 * 返回待重放的记录与扫到的最后一个完整行尾。
 */
export function scanUnackedSettles(meterFile: string, from: number): { items: OutboxItem[]; end: number } {
  const items: OutboxItem[] = [];
  if (!existsSync(meterFile)) return { items, end: 0 };
  const size = statSync(meterFile).size;
  let start = from > size ? 0 : from;
  const fd = openSync(meterFile, "r");
  try {
    let pos = start;
    let carry = Buffer.alloc(0);
    let carryStart = start;
    const buf = Buffer.alloc(1 << 20);
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      let chunk = Buffer.concat([carry, buf.subarray(0, n)]);
      let lineStart = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 0x0a) continue;
        const absStart = carryStart + lineStart;
        const absEnd = carryStart + i + 1;
        const line = chunk.subarray(lineStart, i).toString("utf8");
        lineStart = i + 1;
        start = absEnd;
        if (!line.includes('"settle"')) continue;
        try {
          const j = JSON.parse(line) as { kind?: unknown; holder?: unknown; record?: UsageRecord | null };
          const r = j.record;
          if (j.kind !== "settle" || !r || typeof r !== "object" || typeof r.request_id !== "string" || typeof r.lease_id !== "string" || typeof r.tid !== "string" || typeof j.holder !== "string") continue;
          items.push({ rec: cleanUsageRecord(r), leaseId: r.lease_id, tid: r.tid, holder: j.holder, pos: { start: absStart, end: absEnd } });
        } catch {
          // 坏行（崩溃时写了一半）：跳过
        }
      }
      carry = Buffer.from(chunk.subarray(lineStart));
      carryStart += lineStart;
      chunk = Buffer.alloc(0);
    }
  } finally {
    closeSync(fd);
  }
  return { items, end: start };
}

export class LeaseQuota implements QuotaSource {
  private readonly o: Required<Omit<LeaseQuotaOptions, "outbox" | "leaseSize">> & { outbox: LeaseQuotaOptions["outbox"] | null };
  private readonly leases = new Map<string, LocalLease>();
  private readonly acquiring = new Map<string, Promise<void>>();
  /** 最近一次领取失败（账本拒绝或不可达）：同一席位短时间内不反复打账本。 */
  private readonly lastFailure = new Map<string, { at: number; status: number; code: string; message?: string }>();
  /** 最近一次的预估（后台预取用作 need_estimate）。 */
  private readonly lastNeed = new Map<string, { alias: string; input: number; output: number }>();
  /** 待回报：按租约分组，组内按结算先后。 */
  private readonly pending = new Map<string, OutboxItem[]>();
  private pendingCount = 0;
  /** 已知的最远 settle 行尾（发件箱检查点：没有待回报时即为它）。 */
  private highWater = 0;
  private ackWritten = -1;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private closing = false;
  /** 统计：重放的条数、账本明确不认而放弃的条数（这些仍在 meter.jsonl 里，离线对账可补）。 */
  readonly stats = { replayed: 0, dropped: 0, sent: 0 };

  constructor(o: LeaseQuotaOptions) {
    this.o = {
      ledger: o.ledger,
      holder: o.holder,
      flushMs: o.flushMs ?? 15_000,
      batchSize: o.batchSize ?? 100,
      expiryMarginMs: o.expiryMarginMs ?? 5_000,
      lowWaterRatio: o.lowWaterRatio ?? 0.3,
      now: o.now ?? Date.now,
      outbox: o.outbox ?? null,
    };
    if (this.o.outbox) {
      const ack = readAck(this.o.outbox.ackFile);
      const { items, end } = scanUnackedSettles(this.o.outbox.meterFile, ack);
      // 扫到的最后一个完整行尾之前：要么已确认，要么在待回报里（检查点取二者中较小者）
      this.highWater = end;
      for (const p of items) this.enqueue(p);
      this.stats.replayed = items.length;
      if (items.length) {
        const t = setTimeout(() => void this.flush(), 0);
        t.unref();
      }
    }
    this.timer = setInterval(() => void this.flush(), this.o.flushMs);
    this.timer.unref();
  }

  private enqueue(p: OutboxItem): void {
    const list = this.pending.get(p.leaseId) ?? [];
    list.push(p);
    this.pending.set(p.leaseId, list);
    this.pendingCount += 1;
    if (p.pos) this.highWater = Math.max(this.highWater, p.pos.end);
  }

  private usable(key: string): LocalLease[] {
    const t = this.o.now();
    return [...this.leases.values()].filter((l) => l.key === key && l.expiresAt - this.o.expiryMarginMs > t).sort((a, b) => a.expiresAt - b.expiresAt);
  }

  /** 从未到期租约里扣；返回 hold、拒绝结果，或 null（没有够用的租约）。 */
  private take(key: string, req: ReserveRequest, price: UnitPricer): QuotaHold | ReserveResult | null {
    const list = this.usable(key);
    for (const l of list) {
      const units = price(l.unit);
      if (units === null) return PRICE_UNCONFIGURED;
      if (l.allowedAliases && !l.allowedAliases.has(req.alias)) return { ok: false, status: 403, code: "model_not_allowed", message: "本所的套餐不含这个模型：请联系律所管理员" };
      if (l.remaining >= units) {
        l.remaining -= units;
        l.holds += 1;
        return { tid: req.tid, sid: req.sid, unit: l.unit, units, leaseId: l.id, priceVersion: l.priceVersion };
      }
    }
    return null;
  }

  /** 领取租约（同一席位并发的请求共用一次领取）。`sync` = 本次请求在等（据“发得比所需少”记原因）。 */
  private acquire(key: string, req: ReserveRequest, price: UnitPricer | null): Promise<void> {
    const cur = this.acquiring.get(key);
    if (cur) return cur;
    const p = (async () => {
      const r = await this.o.ledger.lease({ tid: req.tid, sid: req.sid, holder: this.o.holder, need_estimate: { alias: req.alias, input: req.estimate.input, output: req.estimate.output } });
      if (!r.ok) {
        this.lastFailure.set(key, { at: this.o.now(), status: r.status, code: r.code, ...(r.message ? { message: r.message } : {}) });
        return;
      }
      this.leases.set(r.lease_id, {
        id: r.lease_id,
        key,
        tid: req.tid,
        sid: req.sid,
        unit: r.unit,
        units: r.units,
        expiresAt: Date.parse(r.expires_at),
        remaining: r.units,
        holds: 0,
        priceVersion: r.price_version,
        allowedAliases: r.allowed_aliases ? new Set(r.allowed_aliases) : null,
      });
      // 同步领取发得比本次所需少（上限、额度、窗口或个人额度所限）：按 402 报对原因
      const need = price ? price(r.unit) : null;
      if (need !== null && r.limited_by && r.units < need) this.lastFailure.set(key, { at: this.o.now(), status: 402, code: `limited_${r.limited_by}` });
      else this.lastFailure.delete(key);
    })().finally(() => this.acquiring.delete(key));
    this.acquiring.set(key, p);
    return p;
  }

  /**
   * 归还这个席位闲置的租约（第 56 批，真实多成员验收查出）：一份租约余量不够下一次请求时，网关会去领新的；但旧租约没用完的部分在
   * 控制面仍算“在途”，直到 5 分钟到期才释放。额度宽裕时无所谓；接近上限、额度用完或个人额度时，这部分在途把本所（包括持有者自己）
   * 挡在门外——实测上限 0.18 元、已用 0.035 元，全所一次请求也发不出，每 5 分钟才放行一次。
   * 做法：领新租约前，把这个席位没有在途请求的旧租约报最终（先把它待回报的记录送完）。先从本机移除再报，报的过程中别的请求不会再从它扣；
   * 报不成（账本不可达）也只是回到原来的行为：控制面到期后自行收回。
   */
  private async releaseIdle(key: string): Promise<void> {
    const idle = [...this.leases.values()].filter((l) => l.key === key && l.holds === 0);
    if (!idle.length) return;
    if (idle.some((l) => this.pending.has(l.id))) await this.flush();
    for (const l of idle) {
      if (this.leases.get(l.id) !== l || l.holds !== 0 || this.pending.has(l.id)) continue;
      this.leases.delete(l.id);
      await this.o.ledger.settle({ tid: l.tid, lease_id: l.id, holder: this.o.holder, records: [], final: true }).catch(() => null);
    }
  }

  private prefetch(key: string): void {
    const list = this.usable(key);
    const latest = list.at(-1);
    const need = this.lastNeed.get(key);
    if (!latest || !need) return;
    const total = list.reduce((s, l) => s + Math.max(0, l.remaining), 0);
    const f = this.lastFailure.get(key);
    if (total < latest.units * this.o.lowWaterRatio && !(f && this.o.now() - f.at < 2_000)) {
      const [tid, sid] = [latest.tid, latest.sid];
      void this.acquire(key, { tid, sid, alias: need.alias, estimate: { input: need.input, output: need.output } }, null);
    }
  }

  async reserve(req: ReserveRequest, price: UnitPricer): Promise<ReserveResult> {
    if (this.closing) return { ok: false, status: 503, code: "gateway_stopping", message: "网关正在重启，请稍后重试" };
    const key = `${req.tid}|${req.sid}`;
    this.lastNeed.set(key, { alias: req.alias, input: req.estimate.input, output: req.estimate.output });
    let h = this.take(key, req, price);
    const recent = this.lastFailure.get(key);
    // 一份都不够：同步领取，领到后再试一次；刚失败过（1 秒内）不再打账本——账本不可达时每个请求都等超时会拖垮全所请求
    if (h === null && !(recent && this.o.now() - recent.at < 1_000)) {
      await this.releaseIdle(key);
      await this.acquire(key, req, price);
      h = this.take(key, req, price);
      // 共用的是别的请求发起的领取（例如后台预取）、领取成功却不够本次：按本次再领一次（复核 S9A-08②）
      if (h === null && !this.lastFailure.has(key)) {
        await this.acquire(key, req, price);
        h = this.take(key, req, price);
      }
    }
    if (h && "ok" in h) return h;
    if (h) {
      this.prefetch(key);
      return { ok: true, hold: h };
    }
    return this.denial(key);
  }

  /** 拒绝原因（文字给律师看，不出现工程用语）：控制面的 402/403 原样回（状态码 402）。 */
  private denial(key: string): ReserveResult {
    const f = this.lastFailure.get(key);
    if (!f) return { ok: false, status: 402, code: "quota_exhausted", message: "本所 AI 额度暂时不足，请稍后再试" };
    const limited: Record<string, [string, string]> = {
      limited_cap: ["quota_cap_reached", "本所本期 AI 额度已达律所设定的上限：请联系律所管理员"],
      limited_allowance: ["quota_exhausted", "本所本期 AI 额度已用完（100%）：请联系律所管理员加量，或等下期重置"],
      limited_burst: ["quota_burst", "本所 5 小时内的用量已达上限，请稍后再试"],
      limited_seat: ["quota_seat_limit", "您本期的个人 AI 额度已用完：请联系律所管理员"],
    };
    const l = limited[f.code];
    if (l) return { ok: false, status: 402, code: l[0], message: l[1] };
    if (f.status === 402 || f.status === 403) return { ok: false, status: 402, code: f.code, message: f.message ?? "暂时无法为您发放 AI 额度：请联系律所管理员" };
    if (f.status === 0 || f.status === 401 || f.status >= 500) return { ok: false, status: 503, code: "quota_unavailable", message: "暂时无法确认本所 AI 额度，请稍后再试" };
    return { ok: false, status: 402, code: "quota_denied", message: "暂时无法为本所发放 AI 额度：请联系律所管理员" };
  }

  refund(hold: QuotaHold): void {
    const l = hold.leaseId ? this.leases.get(hold.leaseId) : undefined;
    if (!l) return;
    l.remaining += hold.units;
    l.holds = Math.max(0, l.holds - 1);
  }

  settle(hold: QuotaHold, record: UsageRecord, pos: MeterPos | null = null): void {
    const l = hold.leaseId ? this.leases.get(hold.leaseId) : undefined;
    if (l) {
      l.remaining += hold.units - record.charge_units;
      l.holds = Math.max(0, l.holds - 1);
    }
    if (!hold.leaseId) return;
    this.enqueue({ rec: cleanUsageRecord(record), leaseId: hold.leaseId, tid: hold.tid, holder: this.o.holder, pos });
    if (this.pendingCount >= this.o.batchSize) void this.flush();
  }

  private ackedOffset(): number {
    let min = Infinity;
    for (const list of this.pending.values()) for (const p of list) if (p.pos && p.pos.start < min) min = p.pos.start;
    return min === Infinity ? this.highWater : min;
  }

  private writeCheckpoint(): void {
    if (!this.o.outbox) return;
    const off = this.ackedOffset();
    if (off === this.ackWritten) return;
    try {
      writeAck(this.o.outbox.ackFile, off);
      this.ackWritten = off;
    } catch {
      // 检查点写不进去：下次重启多重放一些（控制面按 request_id 去重）
    }
  }

  private dropPending(leaseId: string, n?: number): void {
    const list = this.pending.get(leaseId) ?? [];
    const k = n ?? list.length;
    list.splice(0, k);
    this.pendingCount -= k;
    if (!list.length) this.pending.delete(leaseId);
  }

  /** 回报：有待回报记录的租约分批送；已到期（或 finalAll 时一切）且无在途请求的报最终并移除。 */
  flush(finalAll = false): Promise<void> {
    if (this.flushing) return this.flushing.then(() => (finalAll ? this.flush(true) : undefined));
    this.flushing = (async () => {
      const t = this.o.now();
      const ids = new Set([...this.pending.keys(), ...this.leases.keys()]);
      for (const id of ids) {
        const l = this.leases.get(id);
        // 本机没有这份租约（重放的上一进程的租约）：那个进程已不在，按最终回报
        const expired = l ? (finalAll || l.expiresAt <= t) && l.holds === 0 : true;
        const list = this.pending.get(id) ?? [];
        if (!list.length && !(expired && l)) continue;
        const first = list[0];
        const tid = l?.tid ?? first!.tid;
        const holder = first?.holder ?? this.o.holder;
        let allSent = true;
        do {
          const batch = (this.pending.get(id) ?? []).slice(0, this.o.batchSize);
          const last = batch.length >= (this.pending.get(id)?.length ?? 0);
          const r = await this.o.ledger.settle({ tid, lease_id: id, holder, records: batch.map((p) => p.rec), final: expired && last });
          if (r.ok) {
            this.stats.sent += batch.length;
            this.dropPending(id, batch.length);
            // 第 56 批：控制面收回了这份租约（管理员调低上限、换了套餐）——丢掉本机余量，下一次请求按新约束重新领
            if (r.revoked) this.leases.delete(id);
          } else if (r.code === "lease_unknown" || r.code === "lease_holder_mismatch") {
            // 只有账本明确不认这份租约（过保留期、不属本实例）才放弃（复核 S9A-06）：这些记录仍在 meter.jsonl，离线对账可补
            this.stats.dropped += this.pending.get(id)?.length ?? 0;
            this.dropPending(id);
            this.leases.delete(id);
            allSent = false;
            break;
          } else {
            // 其余失败（不可达、地址指向旧版控制面……）：保留，下个周期再报
            allSent = false;
            break;
          }
        } while (this.pending.get(id)?.length);
        if (allSent && expired) this.leases.delete(id);
      }
      this.writeCheckpoint();
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /**
   * 关闭：停定时器、不再发新的预占，等进行中的请求结算（至多 waitMs，缺省 5 秒），然后对所有租约做**最终回报**——未用部分立即在账本释放
   * （复核 S9A-21）。崩溃时发不出最终回报：下次启动从检查点重放，或按到期 + 宽限释放。
   */
  async close(waitMs = 5_000): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + waitMs;
    while ([...this.leases.values()].some((l) => l.holds > 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await this.flush(true);
  }

  /** 本实例的租约持有者标识（计量 settle 行记下它，重放时按它回报）。 */
  get holder(): string {
    return this.o.holder;
  }

  /** 待回报的条数（诊断）。 */
  get pendingRecords(): number {
    return this.pendingCount;
  }

  /** 测试与诊断：本地租约概况。 */
  snapshot(): { id: string; tid: string; sid: string; unit: QuotaUnit; units: number; remaining: number; holds: number; expiresAt: number }[] {
    return [...this.leases.values()].map(({ id, tid, sid, unit, units, remaining, holds, expiresAt }) => ({ id, tid, sid, unit, units, remaining, holds, expiresAt }));
  }
}
