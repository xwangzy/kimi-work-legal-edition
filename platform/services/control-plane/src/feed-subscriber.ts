/**
 * 网关订阅器（云端服务用，不在律师电脑上：法律模型网关、检索服务；v9 第 04 篇 §5.2；第 02 篇 §9.2 ⑤ 能力网关“二次检查”、§9.13 撤权）。
 *
 * 定时向控制面取签名的订阅（吊销集、事项匿名摘要、律所策略中网关执行的项），按固定的控制面公钥验信封；
 * 版本只进不退（回放的旧订阅不能撤回吊销）；取不到时保留上一份（控制面不可达时网关继续按已知吊销集与摘要工作，第 02 篇 §10）。
 * 订阅内容只有匿名编号与属性——不含事项名称与任何客户内容。
 */
import type { KeyObject } from "node:crypto";
import { openEnvelope, validateSummary, type AnonMatterSummary, type GatewayFeedBody, type GatewayFeedView } from "@zr-legal/firm-trust";


export interface FeedSubscriberOptions {
  /** 控制面订阅地址（…/v1/feed/gateway）。 */
  url: string;
  serviceSecret: string;
  /** 控制面信封公钥（随服务部署固定）。 */
  keys: ReadonlyMap<string, KeyObject>;
  fetchImpl?: typeof fetch;
  /** 按需刷新的最小间隔（缺省 1 秒）。 */
  minRefreshMs?: number;
  timeoutMs?: number;
  /** 放宽类判定要求订阅在这么久之内成功取得过（缺省 10 分钟；复核 S9B-07）。 */
  maxStaleMs?: number;
}

export class GatewayFeedSubscriber implements GatewayFeedView {
  private readonly o: FeedSubscriberOptions;
  private version = 0;
  private revDevices = new Set<string>();
  private revSeats = new Set<string>();
  private matters = new Map<string, AnonMatterSummary>();
  private policies = new Map<string, "deny" | "allow">();
  private supportUpload = new Set<string>();
  private shareRelay = new Set<string>();
  private lastOkAt = 0;
  private lastFetch = 0;
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** 统计（运维）：成功、失败、拒收（信封无效或版本回退）、丢弃的不合法摘要条目。 */
  readonly stats = { ok: 0, failed: 0, rejected: 0, droppedSummaries: 0 };

  constructor(o: FeedSubscriberOptions) {
    this.o = o;
  }

  ready(): boolean {
    return this.version > 0;
  }

  get currentVersion(): number {
    return this.version;
  }

  revokedDevice(tid: string, deviceId: string): boolean {
    return this.revDevices.has(`${tid}\u0000${deviceId}`);
  }

  revokedSeat(seatId: string): boolean {
    return this.revSeats.has(seatId);
  }

  matter(tid: string, anon: string): AnonMatterSummary | null {
    return this.matters.get(`${tid}\u0000${anon}`) ?? null;
  }

  l3aStandardAllowed(tid: string): boolean {
    return this.policies.get(tid) === "allow";
  }

  /**
   * 放宽类判定要求订阅新鲜（复核 S9B-07）：最近一次成功取得订阅超过 maxStaleMs（缺省 10 分钟）即按不允许——
   * 律所关闭开关后，支持服务与控制面之间网络中断也不会无限期按旧订阅放行。
   */
  supportUploadAllowed(tid: string): boolean {
    if (this.lastOkAt === 0 || Date.now() - this.lastOkAt > (this.o.maxStaleMs ?? 10 * 60_000)) return false;
    return this.supportUpload.has(tid);
  }

  /** 律所是否允许经共享中继同步（第 11 批 S11）：与诊断包上传同一新鲜度要求（放宽类判定，订阅过旧即按不允许）。 */
  shareRelayAllowed(tid: string): boolean {
    if (this.lastOkAt === 0 || Date.now() - this.lastOkAt > (this.o.maxStaleMs ?? 10 * 60_000)) return false;
    return this.shareRelay.has(tid);
  }

  /** 最近一次成功取得并接受订阅的时刻（毫秒；0 = 从未）。 */
  get lastOk(): number {
    return this.lastOkAt;
  }

  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (Date.now() - this.lastFetch < (this.o.minRefreshMs ?? 1000)) return Promise.resolve();
    this.inflight = this.fetchOnce().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchOnce(): Promise<void> {
    this.lastFetch = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.o.timeoutMs ?? 10_000);
    try {
      const r = await (this.o.fetchImpl ?? globalThis.fetch)(this.o.url, { headers: { authorization: `Bearer ${this.o.serviceSecret}` }, signal: ac.signal, redirect: "error" });
      if (!r.ok) {
        this.stats.failed += 1;
        return;
      }
      const env = (await r.json()) as unknown;
      const opened = openEnvelope<GatewayFeedBody>(env, "kwl-gateway-feed", this.o.keys);
      const b = opened.ok ? opened.body : null;
      if (!b || !Number.isSafeInteger(b.version) || b.version < this.version || !Array.isArray(b.revoked_devices) || !Array.isArray(b.revoked_seats) || !Array.isArray(b.matters) || !Array.isArray(b.policies)) {
        this.stats.rejected += 1;
        return;
      }
      // 吊销只增不减（与客户端同一粘滞语义；按租户区分——复核 S6-A08）；摘要与策略按最新一份替换
      for (const d of b.revoked_devices) if (d && typeof d.tid === "string" && typeof d.device_id === "string") this.revDevices.add(`${d.tid}\u0000${d.device_id}`);
      for (const s of b.revoked_seats) this.revSeats.add(String(s));
      const matters = new Map<string, AnonMatterSummary>();
      // 摘要逐条按格式校验（复核 S6-B19）：不合法的丢弃（网关对未知事项按请求头检查，不会因此放宽）
      for (const m of b.matters) {
        const tid = (m as { tid?: unknown } | null)?.tid;
        const { tid: _t, ...rest } = (m ?? {}) as unknown as Record<string, unknown>;
        void _t;
        const v = validateSummary(rest);
        if (typeof tid !== "string" || !v.ok) {
          this.stats.droppedSummaries += 1;
          continue;
        }
        matters.set(`${tid}\u0000${v.value.anon}`, v.value);
      }
      this.matters = matters;
      const policies = new Map<string, "deny" | "allow">();
      const supportUpload = new Set<string>();
      const shareRelay = new Set<string>();
      for (const p of b.policies) {
        if (!p || typeof p.tid !== "string") continue;
        policies.set(p.tid, p.l3a_standard_model === "allow" ? "allow" : "deny");
        if (p.support_upload === "allow") supportUpload.add(p.tid);
        if (p.share_relay === "allow") shareRelay.add(p.tid);
      }
      this.policies = policies;
      this.supportUpload = supportUpload;
      this.shareRelay = shareRelay;
      this.lastOkAt = Date.now();
      this.version = b.version;
      this.stats.ok += 1;
    } catch {
      this.stats.failed += 1;
    } finally {
      clearTimeout(timer);
    }
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => {
      this.lastFetch = 0;
      void this.refresh();
    }, Math.max(1000, intervalMs));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
