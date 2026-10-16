/**
 * 团队事项经中软共享中继同步（第 11 批；v9.2 §5.1 S11 ①；v9 第 04 篇“事项账本……介质改为中继对象存储”；含两路复核处置）。
 *
 * 中继只是另一种介质：同步段的格式、封口、签名（含密钥包裹摘要）、证书链与撤权核验、合并规则全部沿用 sync-engine。本服务只做搬运：
 * - 发件（push）：按中继介质导出（段写进本机发件目录 outbox，段体内附块清单），把段与它引用的密文块**切成 4 MiB 的块**上传
 *   （先查缺、只传缺的；块按密文摘要寻址），最后登记段——登记成功才删除发件。上传任何块之前就记下“中继上可能有本事项副本”。
 *   非负责人的设备等负责人先在中继上登记该事项（复核 S11A-04）。失败分三类（复核 S11B-01/09）：传输类停止本轮；
 *   可恢复的按段退避（1 分钟起翻倍、至多 1 小时）；不可恢复的标为“卡住”并如实显示原因（不再反复重试）。
 * - 收件（pull）：长轮询只作“有新段”的唤醒信号；收件处理串行执行。取新段 → 新见到的事项取全部历史（按事项隔离错误）→
 *   段下载后**先做与摄取相同的核验**（证书链、封口签名、撤权；复核 S11A-01），不合格的直接删除，合格的才进收件目录 inbox →
 *   用本机密钥解开段体读块清单 → 缺的密文块取到**暂存区**（ready/<租户>/blobs，不是本机块库），封装摘要、大小与块头事项编号核对 →
 *   块齐的段移到 ready 交 syncImport；syncImport 在核验通过的事务里按“解开后的明文摘要 = 块名”复制进本机块库。
 *   取不回的块按段退避（复核 S11B-06）；传输类失败停止本轮。暂时没有密钥的段留 30 天；本机加入之前纪元的段（永远解不开）即时丢弃。
 *   本机新得到面向自己的包裹时（例如被移出后又加回），该事项重取全部历史（复核 S11B-05）。
 *
 * 读者设备编号取自段里当前纪元的密钥包裹（不含恢复托管、不含本机已知被吊销的设备）——只用来收窄中继上谁能取到密文。
 * 律所策略不允许（share_relay）、未配置中继或未接入控制面、处于退出模式时不收发。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSegment, scanSegments, writeSegment, type SegmentFile } from "@zr-legal/sync";
import type { ShareRelayRequest, ShareRelayResult } from "@zr-legal/egress-gate";
import { blobHeaderOf } from "../blobs.ts";
import { deviceTombstoned } from "../ledger-signer.ts";
import { openSegmentRows, preverifySegment, RELAY_BLOB_TABLE, relayChunks, syncExport, syncImport, type RelayBlobRef, type SyncDeps } from "../sync-engine.ts";

export interface ShareRelayDeps extends SyncDeps {
  /** 本机中继目录（<数据根>/relay）：outbox 发件、inbox 已核验待钥待块、ready 待摄取（含暂存的密文块）。 */
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
  /** 单段段体目标上限（缺省 96 MiB；测试用小值验证拆段）。 */
  partBytes?: number;
  /** 单段引用的新材料字节上限（缺省 1 GiB；测试用小值）。 */
  partBlobBytes?: number;
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
const MATTER_ID_RE = /^mat_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEGMENT_ID_RE = /^seg_[A-Za-z0-9_-]{1,200}_[0-9a-z]{1,13}_[0-9a-f]{8}$/;
const SEGMENT_TAIL_RE = /^[0-9a-z]{1,13}_[0-9a-f]{8}$/;
const CID_RE = /^[0-9a-f]{64}$/;
const BLOB_REL_RE = /^([A-Za-z0-9_-]{1,100})\/([0-9a-f]{64})$/;
/** 没有密钥的收件、取不回块的收件、摄取延后的段：保留 30 天。 */
export const RELAY_HOLD_MS = 30 * 24 * 3600_000;
/** 单条取回失败的段：退避重试（1 分钟起、翻倍、至多 6 小时），7 天仍取不回即丢弃。 */
export const RELAY_RETRY_GIVE_UP_MS = 7 * 24 * 3600_000;
/** 一段至多 64 块（256 MiB）、引用的密文块至多 16384 块、读者至多 1000 台（与中继服务一致）。 */
const MAX_SEGMENT_CHUNKS = 64;
const MAX_BLOB_CHUNKS = 16384;
const MAX_READERS = 1000;
/** 一次收件最多翻几页（每页至多 200 段），其余下个周期再取。 */
const MAX_PAGES = 10;
/** 本机收件目录上限（复核 S11A-10）：段数与总字节；重试表行数。 */
export const RELAY_INBOX_MAX_FILES = 5000;
export const RELAY_INBOX_MAX_BYTES = 2 * 1024 ** 3;
export const RELAY_RETRY_MAX_ROWS = 5000;
/** 暂存区（取回、待摄取的段与密文块）上限（第二轮复核 S11A-10）。 */
export const RELAY_STAGING_MAX_BYTES = 4 * 1024 ** 3;
/** 长轮询醒来但没有新段：至多每 60 秒做一次完整收件（重试、待块、摄取）；其余只推进游标（复核 S11B-11）。 */
const FULL_PULL_EVERY_MS = 60_000;

const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ownedBy = (sid: string, dev: string) => SEGMENT_ID_RE.test(sid) && sid.startsWith(`seg_${dev}_`) && SEGMENT_TAIL_RE.test(sid.slice(`seg_${dev}_`.length));

class RelayError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** 请求去掉凭据（逐个联合成员）：凭据由本服务附上。 */
type RelayCall = ShareRelayRequest extends infer T ? (T extends unknown ? Omit<T, "credential"> : never) : never;

/** 传输与授权类失败（中继或闸门整体不可用）：停止本轮。 */
function transportFailure(code: string): boolean {
  return /timeout|connect|unreachable|gate_|credential_|not_configured|relay_not_allowed|tls_|http_5\d\d|relay_error|relay_bad_reply|relay_bad_json|tenant_unavailable|tenant_purged|http_401/.test(code);
}
/** 发件的可恢复失败：按段退避（复核 S11B-09）。其余非传输类失败为不可恢复（卡住，如实显示）。 */
function recoverablePush(code: string): boolean {
  return /^(epoch_not_established|waiting_for_owner|chunk_missing|http_429|device_pending_full|tenant_storage_full|segment_digest_mismatch|chunk_digest_mismatch|relay_chunk_digest_mismatch|local_blob_changed|http_404|relay_push_failed)$/.test(code);
}

export class ShareRelaySync {
  private readonly d: ShareRelayDeps;
  private cred: { token: string; expiresAt: number } | null = null;
  private credFailUntil = 0;
  private pushing: Promise<RelayReport> | null = null;
  private waiting: Promise<RelayReport> | null = null;
  private pullChain: Promise<unknown> = Promise.resolve();
  private lastFullPull = 0;
  private closed = false;

  constructor(d: ShareRelayDeps) {
    this.d = d;
    // 原子写与改名留下的临时文件（崩溃）：启动时清理（复核 S11B-14）
    for (const dir of [this.outbox, this.inbox, this.ready]) this.sweepTmp(dir);
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
  private iso(t = this.now()): string {
    return new Date(t).toISOString();
  }
  private kv(k: string): string | null {
    return this.d.db.get<{ v: string }>(`SELECT v FROM relay_kv WHERE k = ?`, [k])?.v ?? null;
  }
  private setKv(k: string, v: string): void {
    this.d.db.run(`INSERT INTO relay_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [k, v]);
  }
  private get own(): string {
    return this.d.keyctx.device.deviceId;
  }

  private sweepTmp(dir: string): void {
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (f.startsWith(".tmp-") || f.includes(".tmp-")) rmSync(p, { force: true, recursive: true });
        else if (statSync(p).isDirectory()) walk(p);
      }
    };
    try {
      walk(dir);
    } catch {
      // 下次启动再试
    }
  }

  /** 不能收发的原因（null = 可以）。 */
  blocked(): string | null {
    if (this.closed) return "closed";
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
    // 申领失败后 5 分钟内不再申领（复核 S11B-17：持续失败时不撞控制面的签发频率上限）
    if (this.now() < this.credFailUntil) throw new RelayError("credential_backoff");
    try {
      this.cred = await this.d.credential();
    } catch (e) {
      this.credFailUntil = this.now() + 5 * 60_000;
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

  /** 发件与收件分别记结果（复核 S11B-04：一方空转成功不冲掉另一方的失败）。 */
  private noteResult(phase: "push" | "pull", report: RelayReport): void {
    const at = this.iso();
    if (report.errors.length === 0) {
      this.setKv(`${phase}_last_ok_at`, at);
      // 仍有段在退避或卡住：保留最近的原因，不被空转的成功清掉（第二轮复核 S11B-23①）
      const waiting = phase === "push" ? this.d.db.get<{ last_error: string }>(`SELECT last_error FROM relay_outbox ORDER BY updated_at DESC LIMIT 1`, [])?.last_error : undefined;
      this.setKv(`${phase}_last_error`, waiting ?? "");
    } else {
      this.setKv(`${phase}_last_error`, report.errors[0]!);
      this.setKv(`${phase}_last_error_at`, at);
    }
    if (report.dropped > 0) this.setKv("dropped_total", String((Number(this.kv("dropped_total")) || 0) + report.dropped));
  }

  private isOwner(matterId: string): boolean {
    return !!this.d.db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND matter_role = 'owner' AND removed_at IS NULL`, [
      matterId,
      this.d.keyctx.device.cert.memberId,
    ]);
  }
  private lifecycle(matterId: string): string | undefined {
    return this.d.db.get<{ lifecycle: string }>(`SELECT lifecycle FROM matters WHERE matter_id = ?`, [matterId])?.lifecycle;
  }
  private noteMatter(matterId: string, fields: { known?: boolean; uploaded?: boolean; controller?: unknown }): void {
    const at = this.iso();
    if (typeof fields.controller === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(fields.controller)) {
      this.d.db.run(`INSERT OR IGNORE INTO relay_matters (matter_id, first_seen_at) VALUES (?,?)`, [matterId, at]);
      this.d.db.run(`UPDATE relay_matters SET controller = ? WHERE matter_id = ?`, [fields.controller, matterId]);
    }
    this.d.db.run(`INSERT OR IGNORE INTO relay_matters (matter_id, first_seen_at) VALUES (?,?)`, [matterId, at]);
    if (fields.known) this.d.db.run(`UPDATE relay_matters SET known = 1, known_at = ? WHERE matter_id = ?`, [at, matterId]);
    if (fields.uploaded) this.d.db.run(`UPDATE relay_matters SET uploaded_at = ?, known = 1, known_at = ? WHERE matter_id = ?`, [at, at, matterId]);
  }

  // ─── 发件 ───

  /** 导出并上传（单飞）。 */
  push(force = false): Promise<RelayReport> {
    if (this.pushing) return this.pushing;
    this.pushing = this.doPush(force).finally(() => {
      this.pushing = null;
    });
    return this.pushing;
  }

  /** force = 手动“立即同步”：退避中与卡住的段也立即再试一次（第二轮复核 S11B-23②）。 */
  private async doPush(force = false): Promise<RelayReport> {
    const why = this.blocked();
    if (why) return this.empty(why);
    const report = this.empty();
    try {
      report.exported = syncExport(this.d, {
        shareDir: this.outbox,
        medium: "relay",
        ...(this.d.partBytes ? { partBytes: this.d.partBytes } : {}),
        ...(this.d.partBlobBytes ? { partBlobBytes: this.d.partBlobBytes } : {}),
        // 非负责人第一次导出的起点：本机第一次收到该事项（经中继或共享文件夹，取较早者）——之后本机写入的照常发出
        // （第二轮复核 S11B-22：先经共享文件夹、后开中继的事项，开启前写入、尚未送到负责人的改动也发出；收到过的行按摘要不回传）
        relayJoinedAt: (mid) => {
          const seen = this.d.db.get<{ a: string | null }>(`SELECT MIN(applied_at) AS a FROM sync_segments_seen WHERE matter_id = ?`, [mid])?.a ?? null;
          const relay = this.d.db.get<{ first_seen_at: string }>(`SELECT first_seen_at FROM relay_matters WHERE matter_id = ? AND known = 1`, [mid])?.first_seen_at ?? null;
          return [seen, relay].filter((x): x is string => !!x).sort()[0] ?? null;
        },
      }).segments.length;
    } catch {
      // 导出失败（磁盘满、读块失败等）也如实记下（复核 S11B-04②）
      report.errors.push("export_failed");
    }
    const { candidates } = scanSegments(this.outbox, this.d.tenantId);
    const segs = candidates
      .map((c) => ({ path: c.path, content: c.content, seg: parseSegment(c.content) }))
      .sort(
        (a, b) =>
          (a.seg?.header.from_lamport ?? 0) - (b.seg?.header.from_lamport ?? 0) || (a.seg?.header.segment_id ?? a.path).localeCompare(b.seg?.header.segment_id ?? b.path),
      );
    for (const c of segs) {
      const seg = c.seg;
      if (!seg || seg.header.device_id !== this.own || !ownedBy(seg.header.segment_id, this.own)) {
        rmSync(c.path, { force: true });
        continue;
      }
      const mid = seg.header.matter_id;
      const sid = seg.header.segment_id;
      const st = this.d.db.get<{ state: string; next_at: string | null; attempts: number }>(`SELECT state, next_at, attempts FROM relay_outbox WHERE segment_id = ?`, [sid]);
      // 卡住的每 6 小时再试一次（中继状态可能已由运营修复，复核 S11A-21）；可恢复的按退避时刻
      if (!force && st?.next_at && st.next_at > this.iso()) continue;
      // 已删除的事项、本机已不持钥的：不再发出（删除时也会清理发件目录）
      const lc = this.lifecycle(mid);
      const rows = lc && lc !== "purged" ? openSegmentRows(this.d, seg) : null;
      if (!rows) {
        rmSync(c.path, { force: true });
        this.d.db.run(`DELETE FROM relay_outbox WHERE segment_id = ?`, [sid]);
        continue;
      }
      try {
        // 非负责人的设备：等负责人先在中继上登记该事项（中继上第一个登记者成为控制成员）；确认超过 1 小时即重新确认
        // （运营按事项重置后不能让非负责人抢先登记，复核 S11A-21）
        if (!this.isOwner(mid) && !this.d.db.get(`SELECT 1 AS x FROM relay_matters WHERE matter_id = ? AND known = 1 AND known_at > ?`, [mid, this.iso(this.now() - 3600_000)])) {
          try {
            const h = await this.call({ step: "history", matter_id: mid, since: 0 });
            this.noteMatter(mid, { known: true, controller: h.json?.controller });
          } catch (e) {
            if (e instanceof RelayError && e.code === "matter_unknown") throw new RelayError("waiting_for_owner");
            if (!(e instanceof RelayError && e.code === "not_reader")) throw e;
          }
        }
        const readers = readersOf(seg, this.own, this.d.db);
        if (readers.length > MAX_READERS) throw new RelayError("too_many_readers");
        const blobs: { rel: string; parts: { cid: string; bytes: Buffer }[] }[] = [];
        let blobChunkCount = 0;
        for (const r of rows) {
          if (r.t !== RELAY_BLOB_TABLE) continue;
          const ref = r.row as unknown as RelayBlobRef;
          const env = readFileSync(join(this.d.blobs.dir, ...r.pk.split("/")));
          if (sha256Hex(env) !== ref.sha256) throw new RelayError("local_blob_changed");
          const parts = relayChunks(env);
          blobChunkCount += parts.length;
          if (blobChunkCount > MAX_BLOB_CHUNKS) throw new RelayError("segment_too_large");
          blobs.push({ rel: r.pk, parts });
        }
        const bytes = Buffer.from(c.content, "utf8");
        const segParts = relayChunks(bytes);
        if (segParts.length > MAX_SEGMENT_CHUNKS) throw new RelayError("segment_too_large");
        // 上传任何块之前就记下“中继上可能有本事项副本”（复核 S11B-07：删除回执不漏报）
        this.noteMatter(mid, {});
        for (const b of blobs) await this.upload(mid, b.parts);
        await this.upload(mid, segParts);
        // 登记前复查：事项在上传期间被删除即不登记
        if (this.lifecycle(mid) === "purged") throw new RelayError("matter_purged");
        const committed = await this.call({
          step: "commit",
          matter_id: mid,
          segment_id: sid,
          sha256: sha256Hex(bytes),
          size: bytes.length,
          chunks: segParts.map((p) => p.cid),
          blob_chunks: [...new Set(blobs.flatMap((b) => b.parts.map((p) => p.cid)))],
          epoch: seg.header.key_epoch,
          readers,
        });
        rmSync(c.path, { force: true });
        this.d.db.run(`DELETE FROM relay_outbox WHERE segment_id = ?`, [sid]);
        report.uploaded += 1;
        this.noteMatter(mid, { uploaded: true, controller: committed.json?.controller });
      } catch (e) {
        const code = e instanceof RelayError ? e.code : "relay_push_failed";
        report.errors.push(code);
        if (transportFailure(code)) break;
        if (code === "matter_purged") {
          rmSync(c.path, { force: true });
          continue;
        }
        // 中继说本机不是读者，而本机仍是该事项的在册成员：中继上的事项状态异常（例如被抢先登记），留着、标为卡住待运营处理
        // （复核 S11A-21：不丢弃，处理后自动重发）；本机已被移出的才丢弃
        const stillMember = !!this.d.db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [mid, this.d.keyctx.device.cert.memberId]);
        if (code === "not_reader" && stillMember) {
          this.d.db.run(
            `INSERT INTO relay_outbox (segment_id, matter_id, state, attempts, next_at, last_error, updated_at) VALUES (?,?,'stuck',?,?,?,?)
             ON CONFLICT(segment_id) DO UPDATE SET state = 'stuck', attempts = excluded.attempts, next_at = excluded.next_at, last_error = excluded.last_error, updated_at = excluded.updated_at`,
            [sid, mid, (st?.attempts ?? 0) + 1, this.iso(this.now() + 6 * 3600_000), "relay_matter_conflict", this.iso()],
          );
          report.errors.pop();
          report.errors.push("relay_matter_conflict");
          continue;
        }
        // 本机已不是该事项的读者（被移出）：这一段发不出去，丢弃并计数
        if (code === "not_reader") {
          rmSync(c.path, { force: true });
          this.d.db.run(`DELETE FROM relay_outbox WHERE segment_id = ?`, [sid]);
          report.dropped += 1;
          continue;
        }
        const attempts = (st?.attempts ?? 0) + 1;
        // 等负责人的纪元先到：多次仍不到即标卡住并如实显示（第二轮复核 S11B-19：非控制成员的轮换永远等不到）
        const recoverable = recoverablePush(code) && !(code === "epoch_not_established" && attempts >= 8);
        const next = this.iso(this.now() + (recoverable ? Math.min(60_000 * 2 ** (attempts - 1), 3600_000) : 6 * 3600_000));
        this.d.db.run(
          `INSERT INTO relay_outbox (segment_id, matter_id, state, attempts, next_at, last_error, updated_at) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(segment_id) DO UPDATE SET state = excluded.state, attempts = excluded.attempts, next_at = excluded.next_at, last_error = excluded.last_error, updated_at = excluded.updated_at`,
          [sid, mid, recoverable ? "retry" : "stuck", attempts, next, code, this.iso()],
        );
      }
    }
    this.noteResult("push", report);
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

  /** 取回并摄取；wait = 先长轮询等“有新段”（不在锁里等，手动同步不必等它）。 */
  pull(wait = false): Promise<RelayReport> {
    if (!wait) return this.serial(() => this.doPull());
    if (this.waiting) return this.waiting;
    this.waiting = this.waitThenPull().finally(() => {
      this.waiting = null;
    });
    return this.waiting;
  }

  private async waitThenPull(): Promise<RelayReport> {
    const why = this.blocked();
    if (why) return this.empty(why);
    let woke = true;
    const t0 = Date.now();
    try {
      const { json } = await this.call({ step: "changes", since: Number(this.kv("feed_cursor") ?? "0") || 0, wait: true });
      woke = (Array.isArray(json?.items) && json.items.length > 0) || json?.more === true || (typeof json?.instance === "string" && json.instance !== this.kv("instance"));
    } catch (e) {
      const code = e instanceof RelayError ? e.code : "relay_pull_failed";
      if (code !== "cursor_invalid") {
        const r = this.empty();
        r.errors.push(code);
        this.noteResult("pull", r);
        return r;
      }
    }
    // 醒来没有新段：只在到了重试时刻时做完整收件（复核 S11B-11）；连得上就算一次成功的收取（不清除已记的失败原因）
    if (!woke && this.now() - this.lastFullPull < FULL_PULL_EVERY_MS) {
      this.setKv("pull_last_ok_at", this.iso());
      // 长轮询立即返回又没有新段（中继挂起数已满等）：告诉巡检多等一会儿，不空转（第二轮复核 S11B-27d）
      return { ...this.empty(), ...(Date.now() - t0 < 1_000 ? { reason: "idle_fast" } : {}) };
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
    this.lastFullPull = this.now();
    const report = this.empty();
    try {
      await this.retryDue(report);
      await this.pullFeed(report);
      await this.pullHistories(report);
    } catch (e) {
      report.errors.push(e instanceof RelayError ? e.code : "relay_pull_failed");
    }
    try {
      this.processInbox(report);
      await this.fetchBlobs(report);
    } catch (e) {
      report.errors.push(e instanceof RelayError ? e.code : "relay_blob_failed");
    }
    // 取块失败不妨碍已备齐的段摄取（第二轮复核 S11B-27b）
    try {
      this.importReady(report);
    } catch (e) {
      report.errors.push(e instanceof RelayError ? e.code : "relay_import_failed");
    }
    this.noteResult("pull", report);
    if (report.applied > 0) this.d.onApplied?.(report.applied);
    return report;
  }

  /** 中继实例编号变化（重建、迁移）：从头再取，各事项重取历史（复核 S11B-13）。 */
  private checkInstance(inst: unknown): boolean {
    if (typeof inst !== "string" || !/^[0-9a-f]{24}$/.test(inst)) return false;
    const prev = this.kv("instance");
    if (prev === inst) return false;
    this.setKv("instance", inst);
    if (prev === null) return false;
    this.setKv("feed_cursor", "0");
    this.d.db.run(`UPDATE relay_matters SET history_state = 'pending', history_cursor = 0, history_next_at = NULL, history_attempts = 0, known = 0, controller = NULL`, []);
    // 中继重建：负责人重新全量导出（第二轮复核 S11B-27a）
    this.d.db.run(`DELETE FROM relay_export_state`, []);
    this.d.db.run(`DELETE FROM relay_imported`, []);
    return true;
  }

  private async pullFeed(report: RelayReport): Promise<void> {
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
      if (this.checkInstance(res.json?.instance)) {
        cursor = 0;
        continue;
      }
      for (const it of Array.isArray(res.json?.items) ? (res.json.items as unknown[]) : []) {
        const mid = String((it as any)?.matter_id ?? "");
        // 中继给的事项编号先核对格式（复核 S11A-11）
        if (!MATTER_ID_RE.test(mid)) {
          report.dropped += 1;
          continue;
        }
        this.noteMatter(mid, { known: true });
        await this.fetchOrPark(it, report);
      }
      const next = Number(res.json?.next);
      if (Number.isSafeInteger(next) && next >= cursor) {
        cursor = next;
        this.setKv("feed_cursor", String(cursor));
      }
      if (res.json?.more !== true) break;
    }
  }

  /** 取历史：按事项隔离错误（复核 S11B-06③）；不是读者的记为暂缓、退避重试，不当作完成（复核 S11A-11）。 */
  private async pullHistories(report: RelayReport): Promise<void> {
    for (const m of this.d.db.all<{ matter_id: string; history_cursor: number; history_attempts: number }>(
      `SELECT matter_id, history_cursor, history_attempts FROM relay_matters WHERE history_state != 'done' AND (history_next_at IS NULL OR history_next_at <= ?)`,
      [this.iso()],
    )) {
      if (!MATTER_ID_RE.test(m.matter_id)) {
        this.d.db.run(`DELETE FROM relay_matters WHERE matter_id = ? AND uploaded_at IS NULL`, [m.matter_id]);
        continue;
      }
      try {
        await this.fetchHistory(m.matter_id, m.history_cursor, report);
      } catch (e) {
        const code = e instanceof RelayError ? e.code : "relay_history_failed";
        if (transportFailure(code)) throw e;
        report.errors.push(code);
        const attempts = m.history_attempts + 1;
        this.d.db.run(`UPDATE relay_matters SET history_state = 'denied', history_attempts = ?, history_next_at = ? WHERE matter_id = ?`, [
          attempts,
          this.iso(this.now() + Math.min(60_000 * 2 ** attempts, 24 * 3600_000)),
          m.matter_id,
        ]);
      }
    }
  }

  private async fetchHistory(mid: string, from: number, report: RelayReport): Promise<void> {
    let cursor = from;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.call({ step: "history", matter_id: mid, since: cursor });
      this.noteMatter(mid, { known: true, controller: res.json?.controller });
      for (const it of Array.isArray(res.json?.items) ? (res.json.items as unknown[]) : []) await this.fetchOrPark(it, report);
      const next = Number(res.json?.next);
      if (Number.isSafeInteger(next) && next >= cursor) cursor = next;
      this.d.db.run(`UPDATE relay_matters SET history_cursor = ? WHERE matter_id = ?`, [cursor, mid]);
      if (res.json?.more !== true) {
        this.d.db.run(`UPDATE relay_matters SET history_state = 'done', history_attempts = 0, history_next_at = NULL WHERE matter_id = ?`, [mid]);
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
      if (!SEGMENT_ID_RE.test(sid) || !MATTER_ID_RE.test(mid)) return;
      if ((this.d.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM relay_retry`, [])?.n ?? 0) >= RELAY_RETRY_MAX_ROWS) {
        report.dropped += 1;
        return;
      }
      const at = this.now();
      this.d.db.run(
        `INSERT INTO relay_retry (segment_id, matter_id, item_json, attempts, first_at, next_at, last_error) VALUES (?,?,?,1,?,?,?)
         ON CONFLICT(segment_id) DO NOTHING`,
        [sid, mid, JSON.stringify(item), this.iso(at), this.iso(at + 60_000), e.code],
      );
    }
  }

  /** 到期的重试：取回即删；仍失败则退避；7 天仍取不回丢弃并计数。 */
  private async retryDue(report: RelayReport): Promise<void> {
    const at = this.now();
    for (const r of this.d.db.all<{ segment_id: string; item_json: string; attempts: number; first_at: string }>(
      `SELECT segment_id, item_json, attempts, first_at FROM relay_retry WHERE next_at <= ? ORDER BY next_at LIMIT 50`,
      [this.iso(at)],
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
        this.d.db.run(`UPDATE relay_retry SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE segment_id = ?`, [this.iso(at + delay), e.code, r.segment_id]);
      }
    }
  }

  /** 收件目录的段数与字节（复核 S11A-10）。 */
  private inboxUsage(): { files: number; bytes: number } {
    let files = 0;
    let bytes = 0;
    const segRoot = join(this.inbox, this.d.tenantId, "segments");
    if (!existsSync(segRoot)) return { files, bytes };
    for (const dev of readdirSync(segRoot)) {
      for (const f of readdirSync(join(segRoot, dev))) {
        if (!f.endsWith(".seg")) continue;
        files += 1;
        bytes += statSync(join(segRoot, dev, f)).size;
      }
    }
    return { files, bytes };
  }

  /**
   * 下载一段：整段摘要、段头编号、事项与写入设备核对；**先做与摄取相同的核验**（证书链、封口签名、撤权、本机已删除），
   * 不合格的不落盘（复核 S11A-01）。已摄取、本机自产（按写入设备精确比较，复核 S11B-02）、已在收件的跳过。返回是否新下载。
   */
  private async fetchSegment(item: unknown, report: RelayReport): Promise<boolean> {
    const it = item as { matter_id?: unknown; segment_id?: unknown; dev?: unknown; sha256?: unknown; chunks?: unknown };
    const sid = String(it?.segment_id ?? "");
    const mid = String(it?.matter_id ?? "");
    const dev = String(it?.dev ?? "");
    if (
      !SEGMENT_ID_RE.test(sid) ||
      !MATTER_ID_RE.test(mid) ||
      !DEVICE_ID_RE.test(dev) ||
      !ownedBy(sid, dev) ||
      typeof it.sha256 !== "string" ||
      !CID_RE.test(it.sha256) ||
      !Array.isArray(it.chunks) ||
      it.chunks.length > MAX_SEGMENT_CHUNKS ||
      it.chunks.some((c) => typeof c !== "string" || !CID_RE.test(c))
    ) {
      report.dropped += 1;
      return false;
    }
    if (dev === this.own) return false;
    if (this.d.db.get(`SELECT 1 AS x FROM sync_segments_seen WHERE segment_id = ?`, [sid])) return false;
    if (this.d.db.get(`SELECT 1 AS x FROM relay_unreadable WHERE segment_id = ?`, [sid])) return false;
    // 本机已删除的事项：不再取回（否则密钥包裹与内容回到本机）
    if (this.lifecycle(mid) === "purged") return false;
    if (existsSync(join(this.inbox, this.d.tenantId, "segments", dev, `${sid}.seg`))) return false;
    if (existsSync(join(this.stageOf(sid), this.d.tenantId, "segments", dev, `${sid}.seg`))) return false;
    const usage = this.inboxUsage();
    if (usage.files >= RELAY_INBOX_MAX_FILES || usage.bytes >= RELAY_INBOX_MAX_BYTES) throw new RelayError("inbox_full");
    const parts: Buffer[] = [];
    for (const cid of it.chunks as string[]) parts.push((await this.call({ step: "get_chunk", matter_id: mid, cid })).bytes!);
    const buf = Buffer.concat(parts);
    const seg = sha256Hex(buf) === it.sha256 ? parseSegment(buf.toString("utf8")) : null;
    if (!seg || seg.header.segment_id !== sid || seg.header.matter_id !== mid || seg.header.device_id !== dev) {
      report.dropped += 1;
      return false;
    }
    const pre = preverifySegment(this.d, seg);
    if (!pre.ok) {
      if (pre.outcome !== "own" && pre.outcome !== "seen" && pre.outcome !== "purged") report.dropped += 1;
      return false;
    }
    writeSegment(this.inbox, this.d.tenantId, dev, sid, buf.toString("utf8"));
    return true;
  }

  /** 本机持有面向自己包裹的最低与最高纪元。 */
  private myEpochs(matterId: string): { min: number; max: number } | null {
    const r = this.d.db.get<{ lo: number | null; hi: number | null }>(`SELECT MIN(epoch) AS lo, MAX(epoch) AS hi FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [
      matterId,
      this.own,
    ]);
    return r?.hi ? { min: r.lo!, max: r.hi } : null;
  }

  /** 收件目录：重新核验（状态可能已变）；不合格、已摄取、本机已删除的删除；本机加入之前纪元的丢弃；解不开的留待钥（30 天）。 */
  private processInbox(report: RelayReport): void {
    for (const c of scanSegments(this.inbox, this.d.tenantId).candidates) {
      const seg = parseSegment(c.content);
      const pre = seg ? preverifySegment(this.d, seg) : null;
      if (!seg || !pre || !pre.ok) {
        rmSync(c.path, { force: true });
        continue;
      }
      if (openSegmentRows(this.d, seg)) continue;
      const mine = this.myEpochs(seg.header.matter_id);
      // 负责人在本机加入之前轮换过的纪元：这台电脑永远解不开（复核 S11B-04④），即时丢弃并计数
      // 丢弃时记“本机不可读”，以后不再下载（第二轮复核 S11B-25）
      const unreadable = () =>
        this.d.db.run(`INSERT OR IGNORE INTO relay_unreadable (segment_id, matter_id, at) VALUES (?,?,?)`, [seg.header.segment_id, seg.header.matter_id, this.iso()]);
      if (mine && seg.header.key_epoch < mine.min) {
        rmSync(c.path, { force: true });
        unreadable();
        report.dropped += 1;
        continue;
      }
      if (this.now() - statSync(c.path).mtimeMs > RELAY_HOLD_MS) {
        rmSync(c.path, { force: true });
        unreadable();
        report.dropped += 1;
      } else report.held += 1;
    }
  }

  /** 暂存区占用（字节）。 */
  private readyBytes(): number {
    let n = 0;
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else n += st.size;
      }
    };
    walk(this.ready);
    return n;
  }

  /** 一段的暂存目录（每段一份：段文件与它引用的密文块放在一起，摄取时只看这一段的块——第二轮复核 S11A-22）。 */
  private stageOf(sid: string): string {
    return join(this.ready, sid);
  }

  /**
   * 解得开的收件：把缺的密文块取到这一段自己的暂存目录（核对后），块齐了把段移进去等待摄取；取不回的按段退避（复核 S11B-06①）；
   * 传输类失败停止本轮（②）；暂存区超过上限即暂停（复核 S11A-10）。
   */
  private async fetchBlobs(report: RelayReport): Promise<void> {
    for (const c of scanSegments(this.inbox, this.d.tenantId).candidates) {
      const seg = parseSegment(c.content);
      if (!seg) continue;
      const rows = openSegmentRows(this.d, seg);
      if (!rows) continue;
      const sid = seg.header.segment_id;
      const wait = this.d.db.get<{ next_at: string; attempts: number; first_at: string }>(`SELECT next_at, attempts, first_at FROM relay_blob_wait WHERE segment_id = ?`, [sid]);
      if (wait && wait.next_at > this.iso()) continue;
      if (this.readyBytes() >= RELAY_STAGING_MAX_BYTES) {
        report.errors.push("staging_full");
        return;
      }
      const stage = this.stageOf(sid);
      let failure: string | null = null;
      for (const r of rows) {
        if (r.t !== RELAY_BLOB_TABLE) continue;
        try {
          await this.fetchBlob(seg, r.pk, r.row as unknown as RelayBlobRef, stage);
        } catch (e) {
          const code = e instanceof RelayError ? e.code : "relay_blob_failed";
          if (transportFailure(code)) throw e;
          failure = code;
          break;
        }
      }
      if (failure) {
        report.errors.push(failure);
        const first = wait?.first_at ?? this.iso();
        if (this.now() - Date.parse(first) > RELAY_HOLD_MS) {
          rmSync(c.path, { force: true });
          rmSync(stage, { recursive: true, force: true });
          this.d.db.run(`DELETE FROM relay_blob_wait WHERE segment_id = ?`, [sid]);
          report.dropped += 1;
          continue;
        }
        const attempts = (wait?.attempts ?? 0) + 1;
        this.d.db.run(
          `INSERT INTO relay_blob_wait (segment_id, matter_id, attempts, first_at, next_at, last_error) VALUES (?,?,?,?,?,?)
           ON CONFLICT(segment_id) DO UPDATE SET attempts = excluded.attempts, next_at = excluded.next_at, last_error = excluded.last_error`,
          [sid, seg.header.matter_id, attempts, first, this.iso(this.now() + Math.min(60_000 * 2 ** (attempts - 1), 6 * 3600_000)), failure],
        );
        continue;
      }
      this.d.db.run(`DELETE FROM relay_blob_wait WHERE segment_id = ?`, [sid]);
      const dst = join(stage, this.d.tenantId, "segments", seg.header.device_id, `${sid}.seg`);
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(c.path, dst);
    }
  }

  /**
   * 取回一个密文块到这一段的暂存目录（本机块库已有即跳过；暂存里已有的按这一段块清单里的封装摘要再核一次，不符即重取——
   * 第二轮复核 S11A-22）：封装摘要与大小、块头事项编号核对；明文摘要由摄取时用事项密钥核对。
   */
  private async fetchBlob(seg: SegmentFile, rel: string, ref: RelayBlobRef, stage: string): Promise<void> {
    const m = BLOB_REL_RE.exec(rel);
    // 块只能落在本段事项自己的块目录里
    if (!m || m[1] !== seg.header.matter_id) throw new RelayError("relay_blob_ref_invalid");
    if (!ref || typeof ref.sha256 !== "string" || !CID_RE.test(ref.sha256) || !Number.isSafeInteger(ref.size) || !Array.isArray(ref.chunks) || ref.chunks.some((c) => typeof c !== "string" || !CID_RE.test(c))) {
      throw new RelayError("relay_blob_ref_invalid");
    }
    if (existsSync(join(this.d.blobs.dir, m[1]!, m[2]!))) return;
    const dst = join(stage, this.d.tenantId, "blobs", m[1]!, m[2]!);
    if (existsSync(dst) && sha256Hex(readFileSync(dst)) === ref.sha256) return;
    const parts: Buffer[] = [];
    for (const cid of ref.chunks) parts.push((await this.call({ step: "get_chunk", matter_id: seg.header.matter_id, cid })).bytes!);
    const env = Buffer.concat(parts);
    if (env.length !== ref.size || sha256Hex(env) !== ref.sha256 || blobHeaderOf(env)?.matterId !== seg.header.matter_id) throw new RelayError("relay_blob_mismatch");
    // 事项在取块期间被删除：不写
    if (this.lifecycle(seg.header.matter_id) === "purged") return;
    mkdirSync(dirname(dst), { recursive: true });
    const tmp = `${dst}.tmp-${process.pid}-${Date.now().toString(36)}`;
    writeFileSync(tmp, env);
    renameSync(tmp, dst);
  }

  /** 暂存区里各段（已带段文件的）：按摄取顺序（序号区间、写入设备、段编号）。没有段文件的是取块中途的暂存，过期即删。 */
  private readySegments(): { sid: string; dir: string; path: string; seg: SegmentFile }[] {
    if (!existsSync(this.ready)) return [];
    const out: { sid: string; dir: string; path: string; seg: SegmentFile }[] = [];
    for (const sid of readdirSync(this.ready)) {
      const dir = join(this.ready, sid);
      if (!SEGMENT_ID_RE.test(sid)) {
        // 旧版布局或不认识的目录：清掉
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      const c = scanSegments(dir, this.d.tenantId).candidates.find((x) => parseSegment(x.content)?.header.segment_id === sid);
      const seg = c ? parseSegment(c.content) : null;
      if (!c || !seg) {
        const inInbox = scanSegments(this.inbox, this.d.tenantId).candidates.some((x) => x.path.endsWith(`${sid}.seg`));
        if (!inInbox || this.now() - statSync(dir).mtimeMs > RELAY_HOLD_MS) rmSync(dir, { recursive: true, force: true });
        continue;
      }
      out.push({ sid, dir, path: c.path, seg });
    }
    return out.sort(
      (a, b) => a.seg.header.from_lamport - b.seg.header.from_lamport || a.seg.header.device_id.localeCompare(b.seg.header.device_id) || a.sid.localeCompare(b.sid),
    );
  }

  /** 逐段交 syncImport（核验与合并、只用这一段自己暂存的块，按明文摘要核对后复制）；按去向删除、退回或延后。 */
  private importReady(report: RelayReport): void {
    const ready = this.readySegments();
    const before = new Map<string, number>();
    for (const r of ready) if (!before.has(r.seg.header.matter_id)) before.set(r.seg.header.matter_id, this.myEpochs(r.seg.header.matter_id)?.max ?? 0);
    for (const r of ready) {
      const res = syncImport(this.d, { shareDir: r.dir, trackRelay: true });
      report.applied += res.segmentsApplied;
      const x = res.dispositions.find((d) => d.segment_id === r.sid);
      if (x?.outcome === "no_key") {
        // 摄取时仍解不开（理论上不发生）：退回收件目录
        const back = join(this.inbox, this.d.tenantId, "segments", r.seg.header.device_id, `${r.sid}.seg`);
        mkdirSync(dirname(back), { recursive: true });
        renameSync(r.path, back);
        rmSync(r.dir, { recursive: true, force: true });
        continue;
      }
      if (x?.outcome === "deferred") {
        // 摄取中途出错（依赖的行还没到等）：留着下次再试，30 天后丢弃
        report.held += 1;
        if (this.now() - statSync(r.path).mtimeMs > RELAY_HOLD_MS) {
          rmSync(r.dir, { recursive: true, force: true });
          report.dropped += 1;
        }
        continue;
      }
      rmSync(r.dir, { recursive: true, force: true });
    }
    // 本机新得到面向自己的包裹（新纪元，或被移出后又加回）：该事项重取全部历史（复核 S11B-05）
    for (const [mid, prevMax] of before) {
      const now = this.myEpochs(mid)?.max ?? 0;
      const row = this.d.db.get<{ my_epoch: number }>(`SELECT my_epoch FROM relay_matters WHERE matter_id = ?`, [mid]);
      if (now > Math.max(prevMax, row?.my_epoch ?? 0)) {
        this.d.db.run(`UPDATE relay_matters SET my_epoch = ?, history_state = 'pending', history_cursor = 0, history_next_at = NULL, history_attempts = 0 WHERE matter_id = ?`, [now, mid]);
      } else if (row && now > row.my_epoch) {
        this.d.db.run(`UPDATE relay_matters SET my_epoch = ? WHERE matter_id = ?`, [now, mid]);
      }
    }
  }

  /** 发件与收件各一次（API 与测试用）。 */
  async sync(): Promise<{ push: RelayReport; pull: RelayReport }> {
    const push = await this.push(true);
    const pull = await this.pull(false);
    return { push, pull };
  }

  /** 事项删除后：清理本机中继目录里该事项的段与暂存块，删除导出水位与重试行（块已随块库删除）。 */
  purgeMatter(matterId: string): number {
    let n = 0;
    for (const dir of [this.outbox, this.inbox]) {
      for (const c of scanSegments(dir, this.d.tenantId).candidates) {
        if (parseSegment(c.content)?.header.matter_id === matterId) {
          rmSync(c.path, { force: true });
          n++;
        }
      }
    }
    if (existsSync(this.ready)) {
      for (const sid of readdirSync(this.ready)) {
        const dir = join(this.ready, sid);
        const segOf = scanSegments(dir, this.d.tenantId).candidates.some((c) => parseSegment(c.content)?.header.matter_id === matterId);
        if (segOf || existsSync(join(dir, this.d.tenantId, "blobs", matterId))) {
          rmSync(dir, { recursive: true, force: true });
          n++;
        }
      }
    }
    for (const t of ["relay_export_state", "relay_retry", "relay_outbox", "relay_blob_wait", "relay_imported", "relay_unreadable"]) this.d.db.run(`DELETE FROM ${t} WHERE matter_id = ?`, [matterId]);
    return n;
  }

  /**
   * 经中继同步的事项，中继上的控制成员若不是本人：返回控制成员编号（调整成员、轮换密钥须由他操作——第二轮复核 S11B-19：
   * 否则本机的新纪元永远登记不上，控制成员不知道这次移出，被移出者继续收到新内容）；可以操作返回 null。
   */
  foreignController(matterId: string): string | null {
    if (this.blocked()) return null;
    const c = this.d.db.get<{ controller: string | null }>(`SELECT controller FROM relay_matters WHERE matter_id = ?`, [matterId])?.controller ?? null;
    return c && c !== this.d.keyctx.device.cert.memberId ? c : null;
  }

  /** 关闭：不再开始新的收发，等进行中的结束（至多 timeoutMs；复核 S11B-07）。 */
  async close(timeoutMs = 5_000): Promise<void> {
    this.closed = true;
    await Promise.race([Promise.allSettled([this.pushing, this.pullChain]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  /** 状态（只有计数、时刻与错误代码；计数按目录项，不读段内容——复核 S11B-14）。 */
  status(): Record<string, unknown> {
    const countSeg = (dir: string) => {
      const root = join(dir, this.d.tenantId, "segments");
      if (!existsSync(root)) return 0;
      let n = 0;
      for (const dev of readdirSync(root)) for (const f of readdirSync(join(root, dev))) if (f.endsWith(".seg")) n++;
      return n;
    };
    const stuck = this.d.db.all<{ matter_id: string; last_error: string }>(`SELECT matter_id, last_error FROM relay_outbox WHERE state = 'stuck'`, []);
    const waitingBlob = this.d.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM relay_blob_wait`, [])?.n ?? 0;
    const inboxFiles = countSeg(this.inbox);
    return {
      blocked: this.blocked(),
      configured: this.d.configured(),
      allowed: this.d.allowed(),
      push_last_ok_at: this.kv("push_last_ok_at"),
      push_last_error: this.kv("push_last_error") || null,
      push_last_error_at: this.kv("push_last_error_at"),
      pull_last_ok_at: this.kv("pull_last_ok_at"),
      pull_last_error: this.kv("pull_last_error") || null,
      pull_last_error_at: this.kv("pull_last_error_at"),
      pending_upload: countSeg(this.outbox),
      stuck: stuck.length,
      stuck_matters: [...new Set(stuck.map((s) => s.matter_id))].length,
      stuck_errors: [...new Set(stuck.map((s) => s.last_error))],
      waiting_blob: waitingBlob,
      waiting_key: Math.max(0, inboxFiles - waitingBlob),
      deferred: existsSync(this.ready) ? readdirSync(this.ready).filter((d) => SEGMENT_ID_RE.test(d) && existsSync(join(this.ready, d, this.d.tenantId, "segments"))).length : 0,
      retrying: this.d.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM relay_retry`, [])?.n ?? 0,
      dropped_total: Number(this.kv("dropped_total")) || 0,
      matters: this.d.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM relay_matters`, [])?.n ?? 0,
    };
  }
}

/** 段的读者设备：当前纪元的密钥包裹面向的设备（不含恢复托管、不含本机已知被吊销的设备；复核 S11A-06）+ 写入设备自己。 */
export function readersOf(seg: SegmentFile, own: string, db?: SyncDeps["db"]): string[] {
  const set = new Set<string>([own]);
  for (const kr of seg.key_rows ?? []) {
    if (kr.epoch !== seg.header.key_epoch || kr.wrapped_for === "recovery" || !DEVICE_ID_RE.test(kr.wrapped_for)) continue;
    if (db && (db.get(`SELECT 1 AS x FROM devices WHERE device_id = ? AND status = 'revoked'`, [kr.wrapped_for]) || deviceTombstoned(db, kr.wrapped_for))) continue;
    set.add(kr.wrapped_for);
  }
  return [...set];
}
