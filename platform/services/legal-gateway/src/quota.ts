/**
 * 网关的额度来源（v9.2 §5.1 S3；调研 Y2 §3.3“网关本地持有租户额度租约，本地扣减、定期回填；租约耗尽同步续领；
 * 账本不可达时按剩余租约继续、到期拒绝”）。
 *
 * - `MapQuota`：v0 内存余额（开发与既有用例）；
 * - `LeaseQuota`：向控制面额度账本（services/control-plane quota.ts）领取租约。每次预占从一份**未到期、余量够**的租约里扣，
 *   结算时按实际点数修正该租约的余量并记到席位名下；余量低于水位时后台预取下一份；一份都不够时同步领取；
 *   定期把每份租约的**累计**用量回报账本（重发不重复计费）；租约到期且没有在途请求后做最终回报。
 *   账本不可达：已有租约照常用到期；之后预占失败（`quota_unavailable`，503），不发往上游。
 * - 只有点数、席位编号与请求次数；不含请求内容与匿名事项编号。
 */

export interface QuotaHold {
  readonly tid: string;
  readonly points: number;
  /** LeaseQuota：出自哪份租约。 */
  readonly leaseId?: string;
}

export type ReserveResult = { ok: true; hold: QuotaHold } | { ok: false; status: number; code: string; message: string };

export interface QuotaSource {
  /** 原子预占（检查与扣减不被其他请求插入）。 */
  reserve(tid: string, points: number): Promise<ReserveResult>;
  /** 未发往上游即退还。 */
  refund(hold: QuotaHold): void;
  /** 结算：退还预占、扣实际点数，并记到席位名下。 */
  settle(hold: QuotaHold, sid: string, actual: number): void;
}

/** v0 内存余额（与第 9 批之前的 `budgets` 行为一致）。 */
export class MapQuota implements QuotaSource {
  readonly budgets: Map<string, number>;
  constructor(budgets: Map<string, number>) {
    this.budgets = budgets;
  }
  async reserve(tid: string, points: number): Promise<ReserveResult> {
    const left = this.budgets.get(tid) ?? 0;
    if (left < points) return { ok: false, status: 402, code: "quota_exhausted", message: "本所点数不足（预占失败）" };
    this.budgets.set(tid, left - points);
    return { ok: true, hold: { tid, points } };
  }
  refund(hold: QuotaHold): void {
    this.budgets.set(hold.tid, (this.budgets.get(hold.tid) ?? 0) + hold.points);
  }
  settle(hold: QuotaHold, _sid: string, actual: number): void {
    this.budgets.set(hold.tid, (this.budgets.get(hold.tid) ?? 0) + hold.points - actual);
  }
}

export interface LedgerClient {
  lease(tid: string, want: number, holder: string, need?: number): Promise<{ ok: true; lease_id: string; points: number; expires_at: string; limited_by?: "cap" | "pool" | null } | { ok: false; status: number; code: string }>;
  settle(tid: string, body: { lease_id: string; holder: string; usage: { sid: string; points: number; requests: number }[]; final: boolean }): Promise<{ ok: true } | { ok: false; status: number; code: string }>;
}

/** 经 HTTP 访问控制面额度账本（服务间凭据）。 */
export function httpLedger(o: { baseUrl: string; serviceSecret: string; fetchImpl?: typeof fetch; timeoutMs?: number }): LedgerClient {
  const call = async (path: string, body: unknown): Promise<{ ok: true; json: any } | { ok: false; status: number; code: string }> => {
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
      if (!r.ok) return { ok: false, status: r.status, code: String(json?.error?.code ?? `http_${r.status}`) };
      return { ok: true, json };
    } catch {
      return { ok: false, status: 0, code: "ledger_unreachable" };
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    async lease(tid, want, holder, need) {
      const r = await call("/v1/quota/lease", { tid, want, holder, ...(need ? { need } : {}) });
      if (!r.ok) return r;
      const { lease_id, points, expires_at, limited_by } = r.json ?? {};
      if (typeof lease_id !== "string" || !Number.isSafeInteger(points) || points <= 0 || !Number.isFinite(Date.parse(String(expires_at)))) return { ok: false, status: 502, code: "ledger_reply_invalid" };
      return { ok: true, lease_id, points, expires_at: String(expires_at), limited_by: limited_by === "cap" || limited_by === "pool" ? limited_by : null };
    },
    async settle(tid, body) {
      const r = await call("/v1/quota/settle", { tid, ...body });
      return r.ok ? { ok: true } : r;
    },
  };
}

interface LocalLease {
  id: string;
  tid: string;
  points: number;
  expiresAt: number;
  /** 余量（预占减、结算按实际修正；可为负 = 实际超出估算）。 */
  remaining: number;
  /** 在途预占数。 */
  holds: number;
  /** 累计用量（按席位），回报用。 */
  bySeat: Map<string, { points: number; requests: number }>;
  dirty: boolean;
  finalSent: boolean;
}

export interface LeaseQuotaOptions {
  ledger: LedgerClient;
  /** 本网关实例标识（[A-Za-z0-9_.-]）。 */
  holder: string;
  /** 每次领取的点数（缺省 20000）；一次预占超过它时按预占点数领取。 */
  leaseSize?: number;
  /** 未到期租约的总余量低于它即后台预取（缺省 leaseSize 的 30%）。 */
  lowWatermark?: number;
  /** 回报周期（缺省 15 秒）。 */
  flushMs?: number;
  /** 离到期不足这么久的租约不再用于新的预占（缺省 5 秒：避免请求进行中租约过期）。 */
  expiryMarginMs?: number;
  now?: () => number;
}

export class LeaseQuota implements QuotaSource {
  private readonly o: Required<Omit<LeaseQuotaOptions, "lowWatermark">> & { lowWatermark: number };
  private readonly leases = new Map<string, LocalLease>();
  private readonly acquiring = new Map<string, Promise<void>>();
  /** 最近一次领取失败（账本拒绝或不可达）：同一租户短时间内不反复打账本。 */
  private readonly lastFailure = new Map<string, { at: number; status: number; code: string }>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(o: LeaseQuotaOptions) {
    const leaseSize = o.leaseSize ?? 20_000;
    this.o = { ledger: o.ledger, holder: o.holder, leaseSize, lowWatermark: o.lowWatermark ?? Math.floor(leaseSize * 0.3), flushMs: o.flushMs ?? 15_000, expiryMarginMs: o.expiryMarginMs ?? 5_000, now: o.now ?? Date.now };
    this.timer = setInterval(() => void this.flush(), this.o.flushMs);
    this.timer.unref();
  }

  private usable(tid: string): LocalLease[] {
    const t = this.o.now();
    return [...this.leases.values()].filter((l) => l.tid === tid && l.expiresAt - this.o.expiryMarginMs > t).sort((a, b) => a.expiresAt - b.expiresAt);
  }

  private take(tid: string, points: number): QuotaHold | null {
    const l = this.usable(tid).find((x) => x.remaining >= points);
    if (!l) return null;
    l.remaining -= points;
    l.holds += 1;
    return { tid, points, leaseId: l.id };
  }

  /**
   * 领取租约。`need` = 本次请求所需（同步领取时给出）；后台预取不给（复核 S9A-05：预取把整份租约当“所需”会绕过账本“每次至多发剩余 1/4”，
   * 一个实例拿走全部剩余），也不据预取结果记“已达上限”。
   */
  private acquire(tid: string, need?: number): Promise<void> {
    const cur = this.acquiring.get(tid);
    if (cur) return cur;
    const p = (async () => {
      const r = await this.o.ledger.lease(tid, Math.max(need ?? 0, this.o.leaseSize), this.o.holder, need);
      if (!r.ok) {
        // 预取失败只在账本不可达或拒绝时记（同步领取据此报原因）
        this.lastFailure.set(tid, { at: this.o.now(), status: r.status, code: r.code });
        return;
      }
      // 同步领取发得比本次所需少（上限或池余额所限）：按 402 报对原因
      if (need !== undefined && r.limited_by && r.points < need) this.lastFailure.set(tid, { at: this.o.now(), status: 402, code: r.limited_by === "cap" ? "cap_reached" : "pool_exhausted" });
      else this.lastFailure.delete(tid);
      this.leases.set(r.lease_id, { id: r.lease_id, tid, points: r.points, expiresAt: Date.parse(r.expires_at), remaining: r.points, holds: 0, bySeat: new Map(), dirty: false, finalSent: false });
    })().finally(() => this.acquiring.delete(tid));
    this.acquiring.set(tid, p);
    return p;
  }

  private prefetch(tid: string): void {
    const total = this.usable(tid).reduce((s, l) => s + Math.max(0, l.remaining), 0);
    const f = this.lastFailure.get(tid);
    if (total < this.o.lowWatermark && !(f && this.o.now() - f.at < 2_000)) void this.acquire(tid);
  }

  async reserve(tid: string, points: number): Promise<ReserveResult> {
    let h = this.take(tid, points);
    const recent = this.lastFailure.get(tid);
    // 一份都不够：同步领取（同一租户并发的请求共用同一次领取），领到后再试一次；
    // 刚失败过（1 秒内）不再打账本——账本不可达时每个请求都等超时会拖垮全所请求
    if (!h && !(recent && this.o.now() - recent.at < 1_000)) {
      await this.acquire(tid, points);
      h = this.take(tid, points);
      // 共用的是别的请求发起的领取（例如小额预取）、领取本身成功却不够本次：按本次所需再领一次（复核 S9A-08②）
      if (!h && !this.lastFailure.has(tid)) {
        await this.acquire(tid, points);
        h = this.take(tid, points);
      }
    }
    if (h) {
      this.prefetch(tid);
      return { ok: true, hold: h };
    }
    // 拒绝原因按账本代码映射（复核 S9A-08、S9A-19：文字给律师看，不出现工程用语）
    const f = this.lastFailure.get(tid);
    if (f?.code === "license_expired") return { ok: false, status: 402, code: "quota_license_expired", message: "本所订阅已到期，AI 处理暂停：请联系律所管理员" };
    if (f?.code === "cap_reached") return { ok: false, status: 402, code: "quota_cap_reached", message: "本所本月 AI 额度已达律所设定的上限：请联系律所管理员" };
    if (f?.code === "pool_exhausted") return { ok: false, status: 402, code: "quota_exhausted", message: "本所购买的 AI 额度已用完：请联系律所管理员" };
    if (f && f.status === 401) return { ok: false, status: 503, code: "quota_unavailable", message: "暂时无法确认本所 AI 额度，请稍后再试" };
    if (f && f.status !== 0 && f.status < 500) return { ok: false, status: 402, code: "quota_denied", message: "暂时无法为本所发放 AI 额度：请联系律所管理员" };
    if (!f) return { ok: false, status: 402, code: "quota_exhausted", message: "本所 AI 额度暂时不足，请稍后再试" };
    return { ok: false, status: 503, code: "quota_unavailable", message: "暂时无法确认本所 AI 额度，请稍后再试" };
  }

  refund(hold: QuotaHold): void {
    const l = hold.leaseId ? this.leases.get(hold.leaseId) : undefined;
    if (!l) return;
    l.remaining += hold.points;
    l.holds = Math.max(0, l.holds - 1);
  }

  settle(hold: QuotaHold, sid: string, actual: number): void {
    const l = hold.leaseId ? this.leases.get(hold.leaseId) : undefined;
    if (!l) return;
    l.remaining += hold.points - actual;
    l.holds = Math.max(0, l.holds - 1);
    const u = l.bySeat.get(sid) ?? { points: 0, requests: 0 };
    l.bySeat.set(sid, { points: u.points + actual, requests: u.requests + 1 });
    l.dirty = true;
  }

  /** 回报：有新用量的租约报累计；已到期且无在途请求的报最终并移除。 */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const t = this.o.now();
      for (const l of [...this.leases.values()]) {
        const expired = l.expiresAt <= t && l.holds === 0;
        if (!l.dirty && !expired) continue;
        const usage = [...l.bySeat].map(([sid, u]) => ({ sid, points: u.points, requests: u.requests }));
        const r = await this.o.ledger.settle(l.tid, { lease_id: l.id, holder: this.o.holder, usage, final: expired });
        if (r.ok) {
          l.dirty = false;
          if (expired) this.leases.delete(l.id);
        } else if (r.code === "lease_unknown" || r.code === "lease_holder_mismatch") {
          // 只有账本明确不认这份租约（过保留期、不属本实例）才放弃（复核 S9A-06）：计费以网关计量日志对账。
          // 其他 4xx（地址指向旧版控制面、租户记录丢失……）保留并在下个周期重报，不静默漏记
          this.leases.delete(l.id);
        }
        // 其余失败（不可达）：保留，下个周期再报
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** 关闭：停定时器，把所有租约的累计用量报一次（不标最终：进程重启后的新实例领新租约）。 */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  /** 测试与诊断：本地租约概况。 */
  snapshot(): { id: string; tid: string; points: number; remaining: number; holds: number; expiresAt: number }[] {
    return [...this.leases.values()].map(({ id, tid, points, remaining, holds, expiresAt }) => ({ id, tid, points, remaining, holds, expiresAt }));
  }
}
