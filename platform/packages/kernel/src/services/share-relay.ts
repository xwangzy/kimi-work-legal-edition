/**
 * 团队事项经中软共享中继同步（第 11 批；v9.2 §5.1 S11 ①；v9 第 04 篇“事项账本……介质改为中继对象存储”）。
 *
 * 中继只是另一种介质：同步段的格式、封口、签名、证书链与撤权核验、合并规则全部沿用 sync-engine（与共享文件夹相同）。本服务只做搬运：
 * - 发件（push）：按中继介质导出（段写进本机发件目录 outbox，段体内附块清单），再把段与它引用的密文块**切成 4 MiB 的块**上传
 *   （先查缺、只传缺的；块按密文摘要寻址），最后登记段（段编号、段摘要、块摘要、纪元、读者设备编号）——登记成功才删除发件；
 * - 收件（pull）：按游标取本设备是读者的新段（可长轮询）；第一次见到的事项另取它的全部历史（新加入的成员）；
 *   段下载到收件目录 inbox（整段摘要与段头核对），用本机密钥解开段体读出块清单，把缺的密文块取回本机块库（封装摘要、大小与
 *   块头里的事项编号核对），块齐了的段移到 ready 交 syncImport 摄取；暂时没有密钥的段留在收件目录（30 天后丢弃）。
 *
 * 读者设备编号取自段里面向各设备的密钥包裹（当前纪元，不含恢复托管）——只用来收窄中继上谁能取到密文；能否解密由密钥体系保证。
 * 律所策略不允许（share_relay）、未配置中继或未接入控制面、处于退出模式时不收发。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSegment, scanSegments, writeSegment, type SegmentFile } from "@zr-legal/sync";
import type { ShareRelayRequest, ShareRelayResult } from "@zr-legal/egress-gate";
import { blobHeaderOf } from "../blobs.ts";
import { openSegmentRows, RELAY_BLOB_TABLE, relayChunks, syncExport, syncImport, type RelayBlobRef, type SyncDeps } from "../sync-engine.ts";

export interface ShareRelayDeps extends SyncDeps {
  /** 本机中继目录（<数据根>/relay）：outbox 发件、inbox 已取回待钥待块、ready 待摄取。只放段文件（密文段体 + 明文段头）。 */
  root: string;
  /** 中继地址已配置且接入了控制面。 */
  configured(): boolean;
  /** 律所策略允许经共享中继同步。 */
  allowed(): boolean;
  /** 退出模式（许可到期、本设备被吊销）。 */
  exitMode(): boolean;
  /** 中继专用凭据（受众 relay）。 */
  credential(): Promise<{ token: string; expiresAt: number }>;
  relay(req: ShareRelayRequest): Promise<ShareRelayResult>;
  /** 摄取到新内容后（界面刷新）。 */
  onApplied?(segments: number): void;
  now?(): number;
}

export interface RelayReport {
  ran: boolean;
  reason?: string;
  exported: number;
  uploaded: number;
  downloaded: number;
  applied: number;
  held: number;
  dropped: number;
  errors: string[];
}

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const SEGMENT_ID_RE = /^seg_[A-Za-z0-9_-]{1,280}$/;
const CID_RE = /^[0-9a-f]{64}$/;
const BLOB_REL_RE = /^([A-Za-z0-9_-]{1,100})\/([0-9a-f]{64})$/;
/** 没有密钥的收件保留 30 天。 */
export const RELAY_HOLD_MS = 30 * 24 * 3600_000;
/** 一段至多 64 块（256 MiB）、引用的密文块至多 16384 块（与中继服务一致）。 */
const MAX_SEGMENT_CHUNKS = 64;
const MAX_BLOB_CHUNKS = 16384;
/** 一次收件最多翻几页（每页至多 200 段），其余下个周期再取。 */
const MAX_PAGES = 10;
/** 单条取回失败的段：退避重试（1 分钟起、翻倍、至多 6 小时），7 天仍取不回即丢弃。 */
export const RELAY_RETRY_GIVE_UP_MS = 7 * 24 * 3600_000;

/** 传输与授权类失败（中继或闸门整体不可用）：停止本轮，不把后面的段记成单条失败。 */
function transportFailure(code: string): boolean {
  return /timeout|connect|unreachable|gate_|credential_|not_configured|relay_not_allowed|tls_|http_5\d\d|relay_error|relay_bad_reply|relay_bad_json/.test(code);
}

const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

class RelayError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** 请求去掉凭据（逐个联合成员）：凭据由本服务附上。 */
type RelayCall = ShareRelayRequest extends infer T ? (T extends unknown ? Omit<T, "credential"> : never) : never;

export class ShareRelaySync {
  private cred: { token: string; expiresAt: number } | null = null;
  private pushing: Promise<RelayReport> | null = null;
  /** 超出中继单段上限的段（本进程内不再反复尝试；状态里如实显示，G1 拆段）。 */
  private readonly tooLarge = new Set<string>();
  private waiting: Promise<RelayReport> | null = null;
  private pullChain: Promise<unknown> = Promise.resolve();

  private readonly d: ShareRelayDeps;

  constructor(d: ShareRelayDeps) {
    this.d = d;
  }

  private get outbox(): string {
    return join(this.d.root, "outbox");
  }
  private get inbox(): string {
    return join(this.d.root, "inbox");
  }
  private get ready(): string {
    return join(this.d.root, "ready");
  }
  private now(): number {
    return this.d.now?.() ?? Date.now();
  }
  private kv(k: string): string | null {
    return this.d.db.get<{ v: string }>(`SELECT v FROM relay_kv WHERE k = ?`, [k])?.v ?? null;
  }
  private setKv(k: string, v: string): void {
    this.d.db.run(`INSERT INTO relay_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [k, v]);
  }

  /** 不能收发的原因（null = 可以）。 */
  blocked(): string | null {
    if (!this.d.configured()) return "not_configured";
    if (!this.d.allowed()) return "not_allowed";
    if (this.d.exitMode()) return "exit_mode";
    return null;
  }

  private empty(reason?: string): RelayReport {
    return { ran: !reason, ...(reason ? { reason } : {}), exported: 0, uploaded: 0, downloaded: 0, applied: 0, held: 0, dropped: 0, errors: [] };
  }

  private async token(): Promise<string> {
    if (this.cred && this.cred.expiresAt - this.now() > 10 * 60_000) return this.cred.token;
    try {
      this.cred = await this.d.credential();
    } catch (e) {
      throw new RelayError(`credential_${e instanceof Error ? e.message.replace(/[^a-z0-9_]/gi, "_").slice(0, 40) : "failed"}`);
    }
    return this.cred.token;
  }

  /** 发一个请求；非 2xx 与传输失败一律抛出代码（中继服务的错误代码原样，或闸门的原因）。 */
  private async call(req: RelayCall): Promise<{ json: any; bytes?: Buffer }> {
    const credential = await this.token();
    const r = await this.d.relay({ ...req, credential } as ShareRelayRequest);
    if (!r.ok) throw new RelayError(r.reason);
    if (r.status === 401) this.cred = null;
    if (r.status < 200 || r.status >= 300) {
      let code = `http_${r.status}`;
      try {
        const e = JSON.parse(r.body)?.error;
        if (typeof e === "string" && /^[a-z0-9_]{1,60}$/.test(e)) code = e;
      } catch {
        // 不是 JSON：按状态码
      }
      throw new RelayError(code);
    }
    if (r.body_b64 !== undefined) return { json: null, bytes: Buffer.from(r.body_b64, "base64") };
    try {
      return { json: JSON.parse(r.body) };
    } catch {
      throw new RelayError("relay_bad_json");
    }
  }

  private noteResult(report: RelayReport): void {
    const at = new Date(this.now()).toISOString();
    if (report.errors.length === 0) {
      this.setKv("last_ok_at", at);
      this.setKv("last_error", "");
    } else {
      this.setKv("last_error", report.errors[0]!);
      this.setKv("last_error_at", at);
    }
  }

  // ─── 发件 ───

  /** 导出并上传（单飞）。 */
  push(): Promise<RelayReport> {
    if (this.pushing) return this.pushing;
    this.pushing = this.doPush().finally(() => {
      this.pushing = null;
    });
    return this.pushing;
  }

  private async doPush(): Promise<RelayReport> {
    const why = this.blocked();
    if (why) return this.empty(why);
    const report = this.empty();
    report.exported = syncExport(this.d, { shareDir: this.outbox, medium: "relay" }).segments.length;
    const own = this.d.keyctx.device.deviceId;
    const { candidates } = scanSegments(this.outbox, this.d.tenantId);
    const segs = candidates
      .map((c) => ({ path: c.path, content: c.content, seg: parseSegment(c.content) }))
      .sort((a, b) => (a.seg?.header.from_lamport ?? 0) - (b.seg?.header.from_lamport ?? 0) || a.path.localeCompare(b.path));
    for (const c of segs) {
      const seg = c.seg;
      if (!seg || seg.header.device_id !== own || !SEGMENT_ID_RE.test(seg.header.segment_id)) {
        rmSync(c.path, { force: true });
        continue;
      }
      const mid = seg.header.matter_id;
      if (this.tooLarge.has(seg.header.segment_id)) {
        report.errors.push("segment_too_large");
        continue;
      }
      // 已删除的事项、本机已不持钥的：不再发出（删除时也会清理发件目录）
      const lifecycle = this.d.db.get<{ lifecycle: string }>(`SELECT lifecycle FROM matters WHERE matter_id = ?`, [mid])?.lifecycle;
      const rows = lifecycle && lifecycle !== "purged" ? openSegmentRows(this.d, seg) : null;
      if (!rows) {
        rmSync(c.path, { force: true });
        continue;
      }
      try {
        const blobChunks: string[] = [];
        for (const r of rows) {
          if (r.t !== RELAY_BLOB_TABLE) continue;
          const ref = r.row as unknown as RelayBlobRef;
          const env = readFileSync(join(this.d.blobs.dir, ...r.pk.split("/")));
          if (sha256Hex(env) !== ref.sha256) throw new RelayError("local_blob_changed");
          const parts = relayChunks(env);
          blobChunks.push(...parts.map((p) => p.cid));
          if (new Set(blobChunks).size > MAX_BLOB_CHUNKS) {
            this.tooLarge.add(seg.header.segment_id);
            throw new RelayError("segment_too_large");
          }
          await this.upload(mid, parts);
        }
        const bytes = Buffer.from(c.content, "utf8");
        const parts = relayChunks(bytes);
        if (parts.length > MAX_SEGMENT_CHUNKS || new Set(blobChunks).size > MAX_BLOB_CHUNKS) {
          this.tooLarge.add(seg.header.segment_id);
          throw new RelayError("segment_too_large");
        }
        await this.upload(mid, parts);
        await this.call({
          step: "commit",
          matter_id: mid,
          segment_id: seg.header.segment_id,
          sha256: sha256Hex(bytes),
          size: bytes.length,
          chunks: parts.map((p) => p.cid),
          blob_chunks: [...new Set(blobChunks)],
          epoch: seg.header.key_epoch,
          readers: readersOf(seg, own),
        });
        rmSync(c.path, { force: true });
        report.uploaded += 1;
        this.d.db.run(
          `INSERT INTO relay_matters (matter_id, first_seen_at, uploaded_at) VALUES (?,?,?) ON CONFLICT(matter_id) DO UPDATE SET uploaded_at = excluded.uploaded_at`,
          [mid, new Date(this.now()).toISOString(), new Date(this.now()).toISOString()],
        );
      } catch (e) {
        report.errors.push(e instanceof RelayError ? e.code : "relay_push_failed");
        // 传输类失败：后面的段也发不出去，留到下个周期
        if (!(e instanceof RelayError) || transportFailure(e.code)) break;
      }
    }
    this.noteResult(report);
    return report;
  }

  /** 查缺并上传缺的块。 */
  private async upload(mid: string, parts: { cid: string; bytes: Buffer }[]): Promise<void> {
    const uniq = new Map(parts.map((p) => [p.cid, p.bytes]));
    const cids = [...uniq.keys()];
    for (let i = 0; i < cids.length; i += 512) {
      const { json } = await this.call({ step: "have", matter_id: mid, cids: cids.slice(i, i + 512) });
      const missing = Array.isArray(json?.missing) ? (json.missing as unknown[]).filter((x): x is string => typeof x === "string" && uniq.has(x)) : [];
      for (const cid of missing) await this.call({ step: "put_chunk", matter_id: mid, cid, body_b64: uniq.get(cid)!.toString("base64") });
    }
  }

  // ─── 收件 ───

  /** 取回并摄取（单飞）；wait = 没有新段时长轮询等待。 */
  pull(wait = false): Promise<RelayReport> {
    if (!wait) return this.serial(() => this.doPull());
    if (this.waiting) return this.waiting;
    this.waiting = this.waitThenPull().finally(() => {
      this.waiting = null;
    });
    return this.waiting;
  }

  /**
   * 长轮询只作“有新段”的唤醒信号，不在锁里等：手动“立即同步”不必等它（至多 25 秒）返回；
   * 醒来后按普通收件取一次（长轮询回复里的条目由这一次重新取，已在本机的跳过）。
   */
  private async waitThenPull(): Promise<RelayReport> {
    const why = this.blocked();
    if (why) return this.empty(why);
    try {
      await this.call({ step: "changes", since: Number(this.kv("feed_cursor") ?? "0") || 0, wait: true });
    } catch (e) {
      const code = e instanceof RelayError ? e.code : "relay_pull_failed";
      // 游标比中继上的记录多：交给普通收件处理（从头再取）
      if (code !== "cursor_invalid") {
        const r = this.empty();
        r.errors.push(code);
        this.noteResult(r);
        return r;
      }
    }
    return this.serial(() => this.doPull());
  }

  /** 收件串行执行（后台巡检与手动同步不并发处理同一批收件）。 */
  private serial(fn: () => Promise<RelayReport>): Promise<RelayReport> {
    const run = this.pullChain.then(fn, fn);
    this.pullChain = run.catch(() => undefined);
    return run;
  }

  private async doPull(): Promise<RelayReport> {
    const why = this.blocked();
    if (why) return this.empty(why);
    const report = this.empty();
    try {
      await this.retryDue(report);
      let cursor = Number(this.kv("feed_cursor") ?? "0") || 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        let res: { json: any };
        try {
          res = await this.call({ step: "changes", since: cursor, wait: false });
        } catch (e) {
          // 中继上的记录比本机游标少（中继重建或律所数据被整体删除）：从头再取（已摄取的段按编号跳过）
          if (e instanceof RelayError && e.code === "cursor_invalid" && cursor > 0) {
            cursor = 0;
            this.setKv("feed_cursor", "0");
            continue;
          }
          throw e;
        }
        const items = Array.isArray(res.json?.items) ? (res.json.items as unknown[]) : [];
        for (const it of items) {
          const mid = String((it as any)?.matter_id ?? "");
          if (!this.d.db.get(`SELECT 1 AS x FROM relay_matters WHERE matter_id = ?`, [mid])) {
            this.d.db.run(`INSERT OR IGNORE INTO relay_matters (matter_id, first_seen_at) VALUES (?,?)`, [mid, new Date(this.now()).toISOString()]);
          }
          await this.fetchOrPark(it, report);
        }
        const next = Number(res.json?.next);
        if (Number.isSafeInteger(next) && next >= cursor) {
          cursor = next;
          this.setKv("feed_cursor", String(cursor));
        }
        if (res.json?.more !== true) break;
      }
      // 第一次见到的事项：取全部历史（新加入的成员需要更早的段）
      for (const m of this.d.db.all<{ matter_id: string; history_cursor: number }>(`SELECT matter_id, history_cursor FROM relay_matters WHERE history_done = 0`, [])) {
        await this.fetchHistory(m.matter_id, m.history_cursor, report);
      }
    } catch (e) {
      report.errors.push(e instanceof RelayError ? e.code : "relay_pull_failed");
    }
    try {
      this.processInbox(report);
      await this.fetchBlobsAndImport(report);
    } catch (e) {
      report.errors.push(e instanceof RelayError ? e.code : "relay_import_failed");
    }
    this.noteResult(report);
    if (report.applied > 0) this.d.onApplied?.(report.applied);
    return report;
  }

  private async fetchHistory(mid: string, from: number, report: RelayReport): Promise<void> {
    let cursor = from;
    for (let page = 0; page < MAX_PAGES; page++) {
      let res: { json: any };
      try {
        res = await this.call({ step: "history", matter_id: mid, since: cursor });
      } catch (e) {
        // 不再是读者（被移出、事项轮换了密钥）：不取历史
        if (e instanceof RelayError && (e.code === "not_reader" || e.code === "cursor_invalid")) {
          this.d.db.run(`UPDATE relay_matters SET history_done = 1 WHERE matter_id = ?`, [mid]);
          return;
        }
        throw e;
      }
      for (const it of Array.isArray(res.json?.items) ? (res.json.items as unknown[]) : []) await this.fetchOrPark(it, report);
      const next = Number(res.json?.next);
      if (Number.isSafeInteger(next) && next >= cursor) cursor = next;
      this.d.db.run(`UPDATE relay_matters SET history_cursor = ? WHERE matter_id = ?`, [cursor, mid]);
      if (res.json?.more !== true) {
        this.d.db.run(`UPDATE relay_matters SET history_done = 1 WHERE matter_id = ?`, [mid]);
        return;
      }
    }
  }

  /** 取回一段；单条失败（块被换、块缺失、不再是读者等）记入重试表、不堵住后面的段；传输类失败照常抛出。 */
  private async fetchOrPark(item: unknown, report: RelayReport): Promise<void> {
    try {
      if (await this.fetchSegment(item, report)) report.downloaded += 1;
    } catch (e) {
      if (!(e instanceof RelayError) || transportFailure(e.code)) throw e;
      const sid = String((item as { segment_id?: unknown })?.segment_id ?? "");
      const mid = String((item as { matter_id?: unknown })?.matter_id ?? "");
      report.errors.push(e.code);
      if (!SEGMENT_ID_RE.test(sid)) return;
      const at = this.now();
      this.d.db.run(
        `INSERT INTO relay_retry (segment_id, matter_id, item_json, attempts, first_at, next_at, last_error) VALUES (?,?,?,1,?,?,?)
         ON CONFLICT(segment_id) DO NOTHING`,
        [sid, mid, JSON.stringify(item), new Date(at).toISOString(), new Date(at + 60_000).toISOString(), e.code],
      );
    }
  }

  /** 到期的重试：取回即删；仍失败则退避；7 天仍取不回丢弃并计数。 */
  private async retryDue(report: RelayReport): Promise<void> {
    const at = this.now();
    for (const r of this.d.db.all<{ segment_id: string; item_json: string; attempts: number; first_at: string }>(
      `SELECT segment_id, item_json, attempts, first_at FROM relay_retry WHERE next_at <= ? ORDER BY next_at LIMIT 50`,
      [new Date(at).toISOString()],
    )) {
      try {
        if (await this.fetchSegment(JSON.parse(r.item_json), report)) report.downloaded += 1;
        this.d.db.run(`DELETE FROM relay_retry WHERE segment_id = ?`, [r.segment_id]);
      } catch (e) {
        if (!(e instanceof RelayError) || transportFailure(e.code)) throw e;
        report.errors.push(e.code);
        if (at - Date.parse(r.first_at) > RELAY_RETRY_GIVE_UP_MS) {
          this.d.db.run(`DELETE FROM relay_retry WHERE segment_id = ?`, [r.segment_id]);
          report.dropped += 1;
          continue;
        }
        const delay = Math.min(60_000 * 2 ** r.attempts, 6 * 3600_000);
        this.d.db.run(`UPDATE relay_retry SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE segment_id = ?`, [new Date(at + delay).toISOString(), e.code, r.segment_id]);
      }
    }
  }

  /** 下载一段到收件目录（整段摘要、段头编号与事项核对）；已摄取、本机自产、已在收件的跳过。返回是否新下载。 */
  private async fetchSegment(item: unknown, report: RelayReport): Promise<boolean> {
    const it = item as { matter_id?: unknown; segment_id?: unknown; sha256?: unknown; size?: unknown; chunks?: unknown };
    const sid = String(it?.segment_id ?? "");
    const mid = String(it?.matter_id ?? "");
    if (!SEGMENT_ID_RE.test(sid) || typeof it.sha256 !== "string" || !CID_RE.test(it.sha256) || !Array.isArray(it.chunks) || it.chunks.some((c) => typeof c !== "string" || !CID_RE.test(c))) {
      report.dropped += 1;
      return false;
    }
    if (sid.startsWith(`seg_${this.d.keyctx.device.deviceId}_`)) return false;
    if (this.d.db.get(`SELECT 1 AS x FROM sync_segments_seen WHERE segment_id = ?`, [sid])) return false;
    // 本机已删除的事项：不再取回（否则密钥包裹与内容回到本机）
    if (this.d.db.get<{ lifecycle: string }>(`SELECT lifecycle FROM matters WHERE matter_id = ?`, [mid])?.lifecycle === "purged") return false;
    if (this.findLocal(sid)) return false;
    const parts: Buffer[] = [];
    for (const cid of it.chunks as string[]) {
      const { bytes } = await this.call({ step: "get_chunk", matter_id: mid, cid });
      parts.push(bytes!);
    }
    const buf = Buffer.concat(parts);
    const seg = sha256Hex(buf) === it.sha256 ? parseSegment(buf.toString("utf8")) : null;
    // 段头里的编号、事项与写入设备须与登记一致（写入设备是收件目录名的一部分：只收编号字符）
    if (!seg || seg.header.segment_id !== sid || seg.header.matter_id !== mid || !DEVICE_ID_RE.test(seg.header.device_id) || !sid.startsWith(`seg_${seg.header.device_id}_`)) {
      report.dropped += 1;
      return false;
    }
    writeSegment(this.inbox, this.d.tenantId, seg.header.device_id, sid, buf.toString("utf8"));
    return true;
  }

  private findLocal(sid: string): boolean {
    const dev = /^seg_(.+?)_[0-9a-z]+_[0-9a-f]{8}$/.exec(sid)?.[1];
    if (!dev || !DEVICE_ID_RE.test(dev)) return false;
    for (const dir of [this.inbox, this.ready]) if (existsSync(join(dir, this.d.tenantId, "segments", dev, `${sid}.seg`))) return true;
    return false;
  }

  /** 收件目录：已摄取与本机自产的删除；解不开的留待钥（30 天后丢弃）。 */
  private processInbox(report: RelayReport): void {
    const { candidates } = scanSegments(this.inbox, this.d.tenantId);
    for (const c of candidates) {
      const seg = parseSegment(c.content);
      if (!seg || seg.header.device_id === this.d.keyctx.device.deviceId || this.d.db.get(`SELECT 1 AS x FROM sync_segments_seen WHERE segment_id = ?`, [seg.header.segment_id])) {
        rmSync(c.path, { force: true });
        continue;
      }
      if (this.d.db.get<{ lifecycle: string }>(`SELECT lifecycle FROM matters WHERE matter_id = ?`, [seg.header.matter_id])?.lifecycle === "purged") {
        rmSync(c.path, { force: true });
        continue;
      }
      if (!openSegmentRows(this.d, seg)) {
        if (this.now() - statSync(c.path).mtimeMs > RELAY_HOLD_MS) {
          rmSync(c.path, { force: true });
          report.dropped += 1;
        } else report.held += 1;
      }
    }
  }

  /** 解得开的收件：取回缺的密文块（核对后写进本机块库），块齐了移到 ready，再交 syncImport。 */
  private async fetchBlobsAndImport(report: RelayReport): Promise<void> {
    const { candidates } = scanSegments(this.inbox, this.d.tenantId);
    for (const c of candidates) {
      const seg = parseSegment(c.content);
      if (!seg) continue;
      const rows = openSegmentRows(this.d, seg);
      if (!rows) continue;
      let complete = true;
      for (const r of rows) {
        if (r.t !== RELAY_BLOB_TABLE) continue;
        const ok = await this.fetchBlob(seg, r.pk, r.row as unknown as RelayBlobRef).catch((e: unknown) => {
          report.errors.push(e instanceof RelayError ? e.code : "relay_blob_failed");
          return false;
        });
        if (!ok) complete = false;
      }
      if (!complete) {
        // 密文块一直取不回（中继上缺失或被换）：与待钥同一期限后丢弃
        if (this.now() - statSync(c.path).mtimeMs > RELAY_HOLD_MS) {
          rmSync(c.path, { force: true });
          report.dropped += 1;
        }
        continue;
      }
      const dst = join(this.ready, this.d.tenantId, "segments", seg.header.device_id, `${seg.header.segment_id}.seg`);
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(c.path, dst);
    }
    if (scanSegments(this.ready, this.d.tenantId).candidates.length === 0) return;
    const res = syncImport(this.d, { shareDir: this.ready });
    report.applied += res.segmentsApplied;
    for (const x of res.dispositions) {
      if (x.outcome === "no_key" && x.segment_id) {
        // 摄取时仍解不开（理论上不发生）：退回收件目录
        const back = join(this.inbox, this.d.tenantId, "segments", dirname(x.path).split(/[\\/]/).pop()!, `${x.segment_id}.seg`);
        mkdirSync(dirname(back), { recursive: true });
        renameSync(x.path, back);
        continue;
      }
      rmSync(x.path, { force: true });
    }
  }

  /** 取回一个密文块（本机已有即跳过）：封装摘要与大小、块头里的事项编号核对，原子写进本机块库。 */
  private async fetchBlob(seg: SegmentFile, rel: string, ref: RelayBlobRef): Promise<boolean> {
    const m = BLOB_REL_RE.exec(rel);
    // 块只能落在本段事项自己的块目录里
    if (!m || m[1] !== seg.header.matter_id) throw new RelayError("relay_blob_ref_invalid");
    if (!ref || typeof ref.sha256 !== "string" || !CID_RE.test(ref.sha256) || !Number.isSafeInteger(ref.size) || !Array.isArray(ref.chunks) || ref.chunks.some((c) => typeof c !== "string" || !CID_RE.test(c))) {
      throw new RelayError("relay_blob_ref_invalid");
    }
    const dst = join(this.d.blobs.dir, m[1]!, m[2]!);
    if (existsSync(dst)) return true;
    const parts: Buffer[] = [];
    for (const cid of ref.chunks) parts.push((await this.call({ step: "get_chunk", matter_id: seg.header.matter_id, cid })).bytes!);
    const env = Buffer.concat(parts);
    if (env.length !== ref.size || sha256Hex(env) !== ref.sha256 || blobHeaderOf(env)?.matterId !== seg.header.matter_id) throw new RelayError("relay_blob_mismatch");
    mkdirSync(dirname(dst), { recursive: true });
    const tmp = `${dst}.tmp-${process.pid}-${Date.now().toString(36)}`;
    writeFileSync(tmp, env);
    renameSync(tmp, dst);
    return true;
  }

  /** 发件与收件各一次（API 与测试用）。 */
  async sync(): Promise<{ push: RelayReport; pull: RelayReport }> {
    const push = await this.push();
    const pull = await this.pull(false);
    return { push, pull };
  }

  /** 事项删除后：清理本机中继目录里该事项的段，删除导出水位（块已随块库删除）。 */
  purgeMatter(matterId: string): number {
    let n = 0;
    for (const dir of [this.outbox, this.inbox, this.ready]) {
      for (const c of scanSegments(dir, this.d.tenantId).candidates) {
        if (parseSegment(c.content)?.header.matter_id === matterId) {
          rmSync(c.path, { force: true });
          n++;
        }
      }
    }
    this.d.db.run(`DELETE FROM relay_export_state WHERE matter_id = ?`, [matterId]);
    this.d.db.run(`DELETE FROM relay_retry WHERE matter_id = ?`, [matterId]);
    return n;
  }

  status(): Record<string, unknown> {
    const count = (dir: string) => scanSegments(dir, this.d.tenantId).candidates.length;
    return {
      blocked: this.blocked(),
      configured: this.d.configured(),
      allowed: this.d.allowed(),
      last_ok_at: this.kv("last_ok_at"),
      last_error: this.kv("last_error") || null,
      last_error_at: this.kv("last_error_at"),
      pending_upload: count(this.outbox),
      held: count(this.inbox),
      retrying: this.d.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM relay_retry`, [])?.n ?? 0,
      matters: this.d.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM relay_matters`, [])?.n ?? 0,
    };
  }
}

/** 段的读者设备：当前纪元的密钥包裹面向的设备（不含恢复托管）+ 写入设备自己。 */
export function readersOf(seg: SegmentFile, own: string): string[] {
  const set = new Set<string>([own]);
  for (const kr of seg.key_rows ?? []) {
    if (kr.epoch === seg.header.key_epoch && kr.wrapped_for !== "recovery" && DEVICE_ID_RE.test(kr.wrapped_for)) set.add(kr.wrapped_for);
  }
  return [...set].slice(0, 200);
}
