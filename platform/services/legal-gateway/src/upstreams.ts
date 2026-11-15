/**
 * 上游健康（V19 第 44 批，主文 §3.3）：每个上游（按 id）的并发名额、被动熔断、主动探测与健康回报。
 *
 * - 并发：每个上游每个网关实例至多 `max_concurrency` 个在途请求；
 * - 被动熔断：连续 3 次失败（连接失败 / 5xx / 429 / 头超时）→ 打开 30 秒 → 半开放只放 1 个请求，成功即关闭、失败再开 30 秒；
 * - 主动探测：每 60 秒 `GET {base}/models`（带密钥）；`probe_requested_at` 比上次探测新就立即探一次；
 * - 回报：每 15 秒 `POST {cp}/v1/feed/routing-health`（服务凭据），只有状态、延迟、短错误代码，不含上游正文与密钥。
 * 地址或密钥换了（fingerprint 变化）即重置该上游的健康记录。
 */
import type { ProviderEntry, RoutingSnapshot, RoutingView } from "./routing.ts";

export type HealthState = "up" | "degraded" | "down" | "blocked_by_allowlist" | "key_unusable" | "disabled";

export interface ProviderHealth {
  state: HealthState;
  latency_ms: number | null;
  last_ok_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  inflight: number;
  probed_at: string | null;
}

interface Track {
  fingerprint: string;
  failures: number;
  openUntil: number;
  /** 熔断打开过、正在半开放（只放 1 个）。 */
  halfOpen: boolean;
  halfOpenBusy: boolean;
  inflight: number;
  waiters: (() => void)[];
  latencyMs: number | null;
  lastOkAt: string | null;
  lastError: string | null;
  probedAt: string | null;
  lastProbeAt: number;
  probing: boolean;
}

export interface UpstreamHealthOptions {
  /** 是否启用熔断（静态单上游的开发与试用形态缺省不启用：单上游熔断只会让短暂故障变成 30 秒不可用）。 */
  breaker?: boolean;
  failureThreshold?: number;
  openMs?: number;
  now?: () => number;
}

/** 一次尝试领到的名额：完成时按结果调用其一（只调一次）。 */
export interface UpstreamTicket {
  success(latencyMs: number): void;
  failure(code: string): void;
  /** 上游答了但不是可切换的失败（非 429 的 4xx）：熔断视为可达，记下错误代码。 */
  neutral(code: string): void;
  /** 不计入熔断的结束（没发出去，或流到一半块间隔超时）：只释放名额，给出代码即记为最近错误。 */
  cancel(code?: string): void;
}

const CODE_RE = /^[a-z0-9_]{1,48}$/;

export class UpstreamHealth {
  private readonly o: Required<UpstreamHealthOptions>;
  private readonly t = new Map<string, Track>();
  private probeTimer: NodeJS.Timeout | null = null;
  private reportTimer: NodeJS.Timeout | null = null;
  readonly stats = { reports_ok: 0, reports_failed: 0, probes: 0 };

  constructor(o: UpstreamHealthOptions = {}) {
    this.o = { breaker: o.breaker ?? true, failureThreshold: o.failureThreshold ?? 3, openMs: o.openMs ?? 30_000, now: o.now ?? Date.now };
  }

  private track(e: ProviderEntry): Track {
    let k = this.t.get(e.id);
    if (!k || k.fingerprint !== e.fingerprint) {
      const inflight = k?.inflight ?? 0;
      const waiters = k?.waiters ?? [];
      k = { fingerprint: e.fingerprint, failures: 0, openUntil: 0, halfOpen: false, halfOpenBusy: false, inflight, waiters, latencyMs: null, lastOkAt: null, lastError: null, probedAt: null, lastProbeAt: 0, probing: false };
      this.t.set(e.id, k);
    }
    return k;
  }

  /** 熔断是否放行（不占名额）。 */
  admits(e: ProviderEntry): boolean {
    if (!this.o.breaker) return true;
    const k = this.track(e);
    if (k.openUntil > this.o.now()) return false;
    if (k.halfOpen && k.halfOpenBusy) return false;
    return true;
  }

  hasCapacity(e: ProviderEntry): boolean {
    return this.track(e).inflight < e.maxConcurrency;
  }

  /** 领并发名额：有空即得；否则排队至多 timeoutMs（null = 超时或被取消）。 */
  async acquire(e: ProviderEntry, timeoutMs: number, signal?: AbortSignal): Promise<UpstreamTicket | null> {
    const k = this.track(e);
    if (k.inflight >= e.maxConcurrency) {
      const ok = await new Promise<boolean>((resolve) => {
        const go = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(true);
        };
        const drop = () => {
          const i = k.waiters.indexOf(go);
          if (i >= 0) k.waiters.splice(i, 1);
          resolve(false);
        };
        const timer = setTimeout(drop, timeoutMs);
        const onAbort = () => {
          clearTimeout(timer);
          drop();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        k.waiters.push(go);
      });
      if (!ok) return null;
    } else k.inflight += 1;
    // 半开放：只放这一个
    let half = false;
    if (this.o.breaker && k.openUntil !== 0 && k.openUntil <= this.o.now()) {
      k.halfOpen = true;
      if (k.halfOpenBusy) {
        this.releaseSlot(k);
        return null;
      }
      k.halfOpenBusy = true;
      half = true;
    }
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      if (half) k.halfOpenBusy = false;
      fn();
      this.releaseSlot(k);
    };
    const now = () => new Date(this.o.now()).toISOString();
    return {
      success: (ms) =>
        finish(() => {
          k.failures = 0;
          k.openUntil = 0;
          k.halfOpen = false;
          k.latencyMs = Math.round(ms);
          k.lastOkAt = now();
        }),
      failure: (code) => finish(() => this.fail(k, code)),
      neutral: (code) =>
        finish(() => {
          k.failures = 0;
          k.openUntil = 0;
          k.halfOpen = false;
          k.lastError = CODE_RE.test(code) ? code : "other";
        }),
      cancel: (code) =>
        finish(() => {
          if (code) k.lastError = CODE_RE.test(code) ? code : "other";
        }),
    };
  }

  private fail(k: Track, code: string): void {
    k.failures += 1;
    k.lastError = CODE_RE.test(code) ? code : "other";
    if (!this.o.breaker) return;
    if (k.halfOpen || k.failures >= this.o.failureThreshold) {
      k.openUntil = this.o.now() + this.o.openMs;
      k.halfOpen = false;
    }
  }

  private releaseSlot(k: Track): void {
    const next = k.waiters.shift();
    if (next) next();
    else k.inflight = Math.max(0, k.inflight - 1);
  }

  /** 主动探测一次（只探 state 为 ok 的上游；同一上游不并发探测）。 */
  async probe(e: ProviderEntry, timeoutMs = 10_000): Promise<void> {
    if (e.state !== "ok" || !e.client?.probe) return;
    const k = this.track(e);
    if (k.probing) return;
    k.probing = true;
    k.lastProbeAt = this.o.now();
    this.stats.probes += 1;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const r = await e.client.probe(ac.signal);
      if (r.status >= 200 && r.status < 300) {
        k.failures = 0;
        k.openUntil = 0;
        k.halfOpen = false;
        k.latencyMs = Date.now() - t0;
        k.lastOkAt = new Date(this.o.now()).toISOString();
      } else if (r.status === 429 || r.status >= 500) this.fail(k, `probe_${r.status}`);
      else k.lastError = `probe_${r.status}`;
    } catch {
      this.fail(k, ac.signal.aborted ? "probe_timeout" : "probe_connect");
    } finally {
      clearTimeout(timer);
      k.probedAt = new Date(this.o.now()).toISOString();
      k.probing = false;
    }
  }

  /** 按需探测：到期（intervalMs）或运营点了“测试连接”（probe_requested_at 比上次探测新）。 */
  probeDue(snap: RoutingSnapshot, intervalMs = 60_000): Promise<void>[] {
    const now = this.o.now();
    const out: Promise<void>[] = [];
    for (const e of snap.providers.values()) {
      if (e.state !== "ok") continue;
      const k = this.track(e);
      const requested = e.probeRequestedAt ? Date.parse(e.probeRequestedAt) : 0;
      if (now - k.lastProbeAt >= intervalMs || requested > k.lastProbeAt) out.push(this.probe(e));
    }
    return out;
  }

  startProbing(view: RoutingView & { onChange?(fn: (s: RoutingSnapshot) => void): void }, intervalMs = 60_000, tickMs = 5_000): void {
    if (this.probeTimer) return;
    view.onChange?.((s) => void this.probeDue(s, intervalMs));
    this.probeTimer = setInterval(() => void this.probeDue(view.current(), intervalMs), Math.max(100, tickMs));
    this.probeTimer.unref();
  }

  report(snap: RoutingSnapshot): Record<string, ProviderHealth> {
    const now = this.o.now();
    const out: Record<string, ProviderHealth> = {};
    for (const e of snap.providers.values()) {
      const k = this.track(e);
      let state: HealthState;
      if (e.state === "blocked_by_allowlist") state = "blocked_by_allowlist";
      else if (e.state === "disabled") state = "disabled";
      else if (e.state === "key_unusable") state = "key_unusable";
      else if (this.o.breaker && k.openUntil > now) state = "down";
      else if (k.failures > 0 || k.halfOpen) state = "degraded";
      else state = "up";
      out[e.id] = { state, latency_ms: k.latencyMs, last_ok_at: k.lastOkAt, last_error: k.lastError, consecutive_failures: k.failures, inflight: k.inflight, probed_at: k.probedAt };
    }
    return out;
  }

  /** 回报一次（失败不抛）。 */
  async reportOnce(o: { url: string; serviceSecret: string; holder: string; view: RoutingView; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<boolean> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 5_000);
    try {
      const r = await (o.fetchImpl ?? globalThis.fetch)(o.url, {
        method: "POST",
        headers: { authorization: `Bearer ${o.serviceSecret}`, "content-type": "application/json" },
        body: JSON.stringify({ holder: o.holder, at: new Date(this.o.now()).toISOString(), providers: this.report(o.view.current()) }),
        signal: ac.signal,
        redirect: "error",
      });
      await r.body?.cancel().catch(() => {});
      if (r.ok) this.stats.reports_ok += 1;
      else this.stats.reports_failed += 1;
      return r.ok;
    } catch {
      this.stats.reports_failed += 1;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  startReporting(o: { url: string; serviceSecret: string; holder: string; view: RoutingView; fetchImpl?: typeof fetch; intervalMs?: number }): void {
    if (this.reportTimer) return;
    this.reportTimer = setInterval(() => void this.reportOnce(o), Math.max(1000, o.intervalMs ?? 15_000));
    this.reportTimer.unref();
  }

  stop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.probeTimer = null;
    this.reportTimer = null;
  }
}
