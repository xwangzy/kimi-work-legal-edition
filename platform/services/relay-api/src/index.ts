/**
 * 共享中继服务 v0（第 11 批；v9.2 §5.1 S11 ①“事项共享密文中继”；v9 第 02 篇“团队协作：端到端加密事项共享（G1）”、
 * 第 04 篇“中继：只追加段 + 内容寻址块；设备签名写入；条件写；不保存成员名单以外的身份信息；不可解密”；调研 Y2 §3.11）。
 *
 * 中继只是律所共享文件夹之外的**另一种介质**：承载端侧 `packages/sync` 的不可变同步段与密文块。它保存的只有：
 * - 块（chunk）：每块 ≤ 4 MiB 的不透明字节，按**密文**的 SHA-256 寻址（明文内容的摘要不出律师电脑）；
 * - 段登记：随机事项编号、段编号、写入设备与写入成员（取自凭据）、段摘要与大小、组成段的块、该段引用的密文块、
 *   密钥纪元与读者设备编号——读者名单只用来**收窄**谁能取到密文（纵深防御）；能否解密、内容是否可信由端侧密钥体系与段签名保证。
 *
 * 接口（凭据只收控制面签发的**只限中继**的短期凭据，受众 relay；按请求行原样匹配，不认查询串与编码）：
 * - `POST /v1/relay/matters/<事项>/have`        {cids} → 还缺哪些块；
 * - `PUT  /v1/relay/matters/<事项>/chunks/<cid>` 原始字节，服务端按实际字节重算摘要；
 * - `POST /v1/relay/matters/<事项>/segments`     登记一段；
 * - `GET  /v1/relay/changes/<游标>[/wait]`       本设备是读者的事项的新段（`/wait` 无新段时至多等 25 秒）；
 * - `GET  /v1/relay/matters/<事项>/segments/<游标>` 某事项的全部段（新成员、加回的成员取历史；中继上没有该事项回 404 matter_unknown）；
 * - `GET  /v1/relay/matters/<事项>/chunks/<cid>` 取块（只给读者、只给已登记段引用的块）；
 * - 运营 `DELETE /v1/relay/ops/tenants/<租户>`（律所退约整体删除）与 `DELETE /v1/relay/ops/tenants/<租户>/matters/<事项>`
 *   （中继上的事项状态异常时按事项重置，例如被抢先登记；复核 S11A-04）。都须运营凭据与操作人，先记访问审计。
 *
 * 写入规则（复核 S11A-03/04、S11B-01/02）：
 * - 段编号必须是 `seg_<写入设备>_<时间>_<8 位十六进制>` 的完整格式（只能以自己的设备写段，前缀相同的设备不会混淆）；
 * - 事项的**控制成员** = 第一个登记该事项的成员（取自凭据，不是自报）。只有控制成员能提升纪元（可一次升多级：负责人离线期间
 *   连续轮换也能恢复），提升即整体替换读者——成员移出须轮换密钥，被移出的设备从此取不到任何段与块；
 *   其他读者登记与当前纪元持平的段（读者取并集），声明更高纪元回 409 `epoch_not_established`（可恢复，等控制成员的段先到）；
 * - 事项已存在时写入设备必须是当前读者。
 * 律所策略（share_relay）不允许时一律拒绝（按订阅二次核对；订阅过旧按不允许）。
 *
 * v0 偏离（如实，D-90/D-91）：存储为本地目录（块文件 + 每租户一份只追加的登记日志，fsync 后才回复；写入失败截回原长度；
 * 某个租户的日志损坏只让该租户不可用）；保留期不按律所策略自动删除；未登记的块 24 小时后按残留删除。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import type { GatewayFeedView } from "@zr-legal/firm-trust";
import { verifySeatToken, SeatTokenError, type SeatClaims } from "@zr-legal/seat-token";

/** 事项编号：`mat_` + UUID（随机生成，不含事项名或时间）。 */
export const MATTER_ID_RE = /^mat_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
export const MEMBER_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
/** 段编号的完整格式：seg_<设备>_<时间（base36）>_<8 位十六进制>。 */
export const SEGMENT_ID_RE = /^seg_[A-Za-z0-9_-]{1,200}_[0-9a-z]{1,13}_[0-9a-f]{8}$/;
const SEGMENT_TAIL_RE = /^[0-9a-z]{1,13}_[0-9a-f]{8}$/;
export const CID_RE = /^[0-9a-f]{64}$/;
const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** 单块上限。 */
export const RELAY_CHUNK_MAX = 4 * 1024 * 1024;
/** 一段至多 64 块（256 MiB）。 */
export const RELAY_MAX_SEGMENT_CHUNKS = 64;
/** 一段引用的密文块至多 16384 个块（约 64 GiB 材料；大案首次同步也够用）。 */
export const RELAY_MAX_BLOB_CHUNKS = 16384;
export const RELAY_MAX_READERS = 1000;
export const RELAY_FEED_BATCH = 200;
export const RELAY_HAVE_MAX = 512;
export const RELAY_WAIT_MS = 25_000;
/** 每台设备同时挂起的长轮询、每个租户的总数。 */
export const RELAY_WAITERS_PER_DEVICE = 4;
export const RELAY_WAITERS_PER_TENANT = 2000;
/** 已上传、未被任何登记段引用的块：24 小时后按残留删除。 */
export const RELAY_UNCOMMITTED_TTL_MS = 24 * 3600_000;
/** 每租户存储上限（缺省 50 GiB；试点按律所规模另配）。 */
export const RELAY_DEFAULT_TENANT_BYTES = 50 * 1024 ** 3;
/** 每台设备“已上传、尚未登记”的字节上限（复核 S11A-07：一台设备不能用未登记的块占满全所存储）。 */
export const RELAY_DEFAULT_DEVICE_PENDING_BYTES = 2 * 1024 ** 3;
const MAX_JSON = 2 * 1024 * 1024;

export interface SegEntry {
  seq: number;
  mid: string;
  sid: string;
  dev: string;
  /** 写入成员（取自凭据）。 */
  uid: string;
  sha: string;
  size: number;
  chunks: string[];
  blobs: string[];
  epoch: number;
  readers: string[];
  at: string;
}
/** 运营按事项重置的记录（登记日志里与段登记交替出现，不占序号）。 */
interface ResetRecord {
  k: "reset";
  mid: string;
  at: string;
  operator: string;
}
interface MatterState {
  /** 控制成员：第一个登记该事项的成员；只有它能提升纪元。 */
  controller: string;
  epoch: number;
  readers: Set<string>;
  segs: Map<string, SegEntry>;
  /** 已被登记段引用的块。 */
  committed: Set<string>;
}
interface ChunkInfo {
  size: number;
  /** 上传时刻（毫秒；未登记的按它清残留）。 */
  at: number;
  /** 上传设备（只在本进程内记，用于未登记字节的按设备上限；重启后读回的块不计入任何设备）。 */
  dev: string | null;
}
interface TenantState {
  tid: string;
  dir: string;
  entries: SegEntry[];
  /** 已被运营重置的段（按序号）：不再出现在取新段与历史里。 */
  gone: Set<number>;
  matters: Map<string, MatterState>;
  /** 各事项被运营重置的次数（“重置代数”，第四轮复核 S11B-36/37）：登记、取历史、取新段与“事项不存在”的回复都带上，客户端据此确定地发现重置。 */
  resets: Map<string, number>;
  /** 被重置过的事项在重置时的读者（第五轮复核 S11A-46：“事项不存在”只对这些设备带重置代数，其他同所设备探测不到重置）。 */
  resetReaders: Map<string, Set<string>>;
  /** `${mid}/${cid}` → 大小、上传时刻与上传设备。 */
  chunks: Map<string, ChunkInfo>;
  bytes: number;
  /** 每台设备未登记的字节（含正在上传的预留）。 */
  pending: Map<string, number>;
  /** 正在整体删除：在途请求读完请求体后发现即放弃（复核 S11A-09）。 */
  purging: boolean;
}

export interface RelayAccessRecord {
  at: string;
  action: "tenant_purge" | "matter_reset";
  operator: string;
  tid: string;
  mid?: string;
  removed_bytes: number;
  result: string;
}

export interface RelayApiOptions {
  dir: string;
  keys: ReadonlyMap<string, KeyObject>;
  /** 吊销集与律所策略（share_relay）；生产形态必须提供。 */
  feed?: Pick<GatewayFeedView, "revokedDevice" | "revokedSeat" | "shareRelayAllowed"> & { refresh?: () => Promise<void> };
  /** 测试与开发形态：不经订阅、直接认定律所允许（生产禁用）。 */
  allowAllTenants?: boolean;
  tenantMaxBytes?: number;
  devicePendingBytes?: number;
  opsSecret?: string;
  accessLog?: (r: RelayAccessRecord) => void;
  production?: boolean;
  now?: () => number;
  waitMs?: number;
  /** 测试用：登记日志写入时注入失败（复核 S11A-08）。 */
  journalWrite?: (fd: number, buf: Buffer) => void;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

const isoOk = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const uniq = (xs: string[]) => new Set(xs).size === xs.length;

/** 段编号属于这台设备：前缀精确、其后正好是“时间_8 位十六进制”（复核 S11A-14、S11B-02）。 */
export function segmentOwnedBy(sid: string, dev: string): boolean {
  const prefix = `seg_${dev}_`;
  return SEGMENT_ID_RE.test(sid) && sid.startsWith(prefix) && SEGMENT_TAIL_RE.test(sid.slice(prefix.length));
}

function fsyncPath(p: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = openSync(p, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // 断电时可能丢失这次改名：生产形态由对象存储与数据库保证（D-90）
  }
}

/** 读回的登记逐条校验（坏记录让该租户不可用）。 */
function validEntry(x: unknown): x is SegEntry {
  const e = x as SegEntry;
  if (!e || typeof e !== "object" || !Number.isSafeInteger(e.seq) || e.seq < 1) return false;
  if (!MATTER_ID_RE.test(String(e.mid)) || !segmentOwnedBy(String(e.sid), String(e.dev)) || !DEVICE_ID_RE.test(String(e.dev)) || !MEMBER_ID_RE.test(String(e.uid))) return false;
  if (!CID_RE.test(String(e.sha)) || !Number.isSafeInteger(e.size) || e.size < 1 || !Number.isSafeInteger(e.epoch) || e.epoch < 1 || !isoOk(e.at)) return false;
  if (!Array.isArray(e.chunks) || e.chunks.length < 1 || e.chunks.some((c) => !CID_RE.test(String(c)))) return false;
  if (!Array.isArray(e.blobs) || e.blobs.some((c) => !CID_RE.test(String(c)))) return false;
  if (!Array.isArray(e.readers) || e.readers.length < 1 || e.readers.some((d) => !DEVICE_ID_RE.test(String(d)))) return false;
  return true;
}
/** 按事项重置：记下重置时的读者，删掉事项状态，重置代数加一。 */
function noteReset(t: TenantState, mid: string): void {
  const prev = t.resetReaders.get(mid) ?? new Set<string>();
  for (const d of t.matters.get(mid)?.readers ?? []) prev.add(d);
  t.resetReaders.set(mid, prev);
  t.matters.delete(mid);
  t.resets.set(mid, (t.resets.get(mid) ?? 0) + 1);
}

function validReset(x: unknown): x is ResetRecord {
  const r = x as ResetRecord;
  return !!r && r.k === "reset" && MATTER_ID_RE.test(String(r.mid)) && isoOk(r.at) && typeof r.operator === "string";
}

/**
 * 按纪元规则合入一段：新事项——写入成员成为控制成员；更高纪元（只有控制成员能登记）整体替换读者；
 * 持平纪元——只有控制成员的段能加读者（第二轮复核 S11A-25：其他读者不能把任意设备加进来，堵住借读者身份投递伪造事项的通道）；更旧不动。
 */
function applyEntry(t: TenantState, e: SegEntry): void {
  let m = t.matters.get(e.mid);
  if (!m) {
    m = { controller: e.uid, epoch: e.epoch, readers: new Set(e.readers), segs: new Map(), committed: new Set() };
    t.matters.set(e.mid, m);
  } else if (e.epoch > m.epoch) {
    m.epoch = e.epoch;
    m.readers = new Set(e.readers);
  } else if (e.epoch === m.epoch && e.uid === m.controller) for (const d of e.readers) m.readers.add(d);
  m.segs.set(e.sid, e);
  for (const c of [...e.chunks, ...e.blobs]) m.committed.add(c);
}

export function createRelayApi(o: RelayApiOptions): Server & {
  sweep(): number;
  tenant(tid: string): { entries: SegEntry[]; bytes: number; chunkFiles: string[]; controller(mid: string): string | null } | null;
  readonly instance: string;
} {
  const now = o.now ?? Date.now;
  const iso = (t = now()) => new Date(t).toISOString();
  const production = o.production ?? process.env.NODE_ENV === "production";
  if (production && !o.feed) throw new Error("生产形态必须接控制面订阅（吊销集与律所策略）");
  if (production && o.allowAllTenants) throw new Error("生产形态不得跳过律所策略核对");
  if (o.opsSecret !== undefined && o.opsSecret.length < 16) throw new Error("opsSecret 至少 16 个字符");
  const tenantMax = o.tenantMaxBytes ?? RELAY_DEFAULT_TENANT_BYTES;
  const devicePendingMax = o.devicePendingBytes ?? RELAY_DEFAULT_DEVICE_PENDING_BYTES;
  const waitMs = o.waitMs ?? RELAY_WAIT_MS;
  mkdirSync(join(o.dir, "t"), { recursive: true, mode: 0o700 });
  // 实例编号（复核 S11B-13）：中继重建或迁移后编号变化，客户端据此重置游标与历史
  const instPath = join(o.dir, "instance");
  if (!existsSync(instPath)) writeFileSync(instPath, randomBytes(12).toString("hex"), { mode: 0o600 });
  const instance = readFileSync(instPath, "utf8").trim();
  if (!/^[0-9a-f]{24}$/.test(instance)) throw new Error("中继实例编号文件格式不符");
  const access = o.accessLog ?? ((r: RelayAccessRecord) => appendFileSync(join(o.dir, "access.jsonl"), `${JSON.stringify(r)}\n`, { mode: 0o600 }));
  const tenants = new Map<string, TenantState>();
  /** 某租户的登记日志或目录读回失败：只让这个租户不可用（复核 S11A-08），其余律所照常。 */
  const badTenants = new Set<string>();
  const waiters = new Map<string, Set<{ dev: string; done: () => void }>>();

  const tenantDir = (tid: string) => join(o.dir, "t", tid);
  const journalOf = (t: TenantState) => join(t.dir, "journal.jsonl");
  const chunkPath = (t: TenantState, mid: string, cid: string) => join(t.dir, "m", mid, cid);
  const fresh = (tid: string): TenantState => ({ tid, dir: tenantDir(tid), entries: [], gone: new Set(), matters: new Map(), resets: new Map(), resetReaders: new Map(), chunks: new Map(), bytes: 0, pending: new Map(), purging: false });

  // ─── 读回：登记日志逐行校验（最后一行写了一半的截掉）；块文件与登记核对 ───
  const load = (tid: string): TenantState => {
    const t = fresh(tid);
    const jp = join(t.dir, "journal.jsonl");
    if (existsSync(jp)) {
      const raw = readFileSync(jp, "utf8");
      const lines = raw.split("\n");
      const tail = lines.pop() ?? "";
      // 最后一行没有换行：写入中断（没有回复过成功），截掉
      if (tail !== "") truncateSync(jp, Buffer.byteLength(raw) - Buffer.byteLength(tail));
      for (const line of lines) {
        let e: unknown;
        try {
          e = JSON.parse(line);
        } catch {
          throw new Error(`中继登记日志有坏行（租户 ${tid}）`);
        }
        if ((e as { k?: unknown })?.k === "reset") {
          if (!validReset(e)) throw new Error(`中继登记日志有不合格的重置记录（租户 ${tid}）`);
          for (const x of t.entries) if (x.mid === e.mid) t.gone.add(x.seq);
          noteReset(t, e.mid);
          continue;
        }
        if (!validEntry(e) || e.seq !== t.entries.length + 1) throw new Error(`中继登记日志有不合格的记录（租户 ${tid}）`);
        t.entries.push(e);
        applyEntry(t, e);
      }
    }
    const mdir = join(t.dir, "m");
    if (existsSync(mdir)) {
      for (const mid of readdirSync(mdir)) {
        if (!MATTER_ID_RE.test(mid)) throw new Error(`中继目录里有不认识的事项目录（租户 ${tid}）`);
        for (const f of readdirSync(join(mdir, mid))) {
          const p = join(mdir, mid, f);
          // 崩溃留下的半成品：删除
          if (f.startsWith(".tmp-")) {
            rmSync(p, { force: true });
            continue;
          }
          if (!CID_RE.test(f)) throw new Error(`中继目录里有不认识的文件（租户 ${tid}）`);
          const st = statSync(p);
          t.chunks.set(`${mid}/${f}`, { size: st.size, at: st.mtimeMs, dev: null });
          t.bytes += st.size;
        }
      }
    }
    for (const [mid, m] of t.matters) for (const c of m.committed) if (!t.chunks.has(`${mid}/${c}`)) throw new Error(`中继登记引用的块缺失（租户 ${tid}）`);
    return t;
  };
  for (const tid of readdirSync(join(o.dir, "t"))) {
    if (!TENANT_RE.test(tid)) throw new Error("中继目录里有不认识的租户目录");
    try {
      tenants.set(tid, load(tid));
    } catch (e) {
      badTenants.add(tid);
      console.error(`[relay] 租户 ${tid} 读回失败，暂不可用：${(e as Error).message}`);
    }
  }
  const tenantOf = (tid: string): TenantState => {
    if (badTenants.has(tid)) throw new HttpError(503, "tenant_unavailable");
    let t = tenants.get(tid);
    if (!t) {
      t = fresh(tid);
      tenants.set(tid, t);
    }
    return t;
  };
  /** 在途请求读完请求体后复查：租户已被整体删除（或替换）即放弃。 */
  const stillLive = (t: TenantState) => {
    if (t.purging || tenants.get(t.tid) !== t) throw new HttpError(410, "tenant_purged");
  };
  const committedIn = (t: TenantState, mid: string, cid: string) => !!t.matters.get(mid)?.committed.has(cid);
  const releasePending = (t: TenantState, dev: string | null, n: number) => {
    if (!dev) return;
    const v = (t.pending.get(dev) ?? 0) - n;
    if (v > 0) t.pending.set(dev, v);
    else t.pending.delete(dev);
  };

  /** 删除超过 24 小时仍未被登记段引用的块；返回删除的块数。 */
  const sweep = (): number => {
    let n = 0;
    const t0 = now();
    for (const t of tenants.values()) {
      for (const [k, c] of t.chunks) {
        const [mid, cid] = k.split("/") as [string, string];
        if (committedIn(t, mid, cid)) continue;
        if (t0 - c.at < RELAY_UNCOMMITTED_TTL_MS) continue;
        rmSync(chunkPath(t, mid, cid), { force: true });
        t.chunks.delete(k);
        t.bytes -= c.size;
        releasePending(t, c.dev, c.size);
        n++;
      }
    }
    return n;
  };
  sweep();
  const timer = setInterval(() => {
    try {
      sweep();
    } catch {
      // 下个周期再试
    }
  }, 3600_000);
  timer.unref();

  const revoked = (tid: string, dev: string) => !!o.feed?.revokedDevice(tid, dev);
  const credential = (req: IncomingMessage): SeatClaims => {
    const tok = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    if (!tok) throw new HttpError(401, "credential_required");
    let c: SeatClaims;
    try {
      // 只收“只限中继”的凭据（受众 relay）；通用席位令牌与其他服务的凭据一律拒收
      c = verifySeatToken(tok, o.keys, { now: now(), audience: "relay", requireAudience: true });
    } catch (e) {
      throw new HttpError(401, `credential_${e instanceof SeatTokenError ? e.reason : "invalid"}`);
    }
    // 声明逐项按类型核对（复核 S11A-17）
    const x = c as unknown as Record<string, unknown>;
    if (typeof x.tid !== "string" || typeof x.dev !== "string" || typeof x.uid !== "string" || typeof x.sid !== "string") throw new HttpError(401, "credential_invalid");
    if (!TENANT_RE.test(c.tid) || !DEVICE_ID_RE.test(c.dev) || !MEMBER_ID_RE.test(c.uid)) throw new HttpError(401, "credential_invalid");
    if (revoked(c.tid, c.dev) || o.feed?.revokedSeat(c.sid)) throw new HttpError(401, "credential_revoked");
    return c;
  };
  /** 律所策略二次核对（订阅里没有或过旧 → 刷新一次再判）。 */
  const policyOk = async (tid: string): Promise<boolean> => {
    if (o.allowAllTenants) return true;
    if (o.feed?.shareRelayAllowed?.(tid)) return true;
    if (!o.feed?.refresh) return false;
    await o.feed.refresh().catch(() => {});
    return !!o.feed.shareRelayAllowed?.(tid);
  };
  const device = async (req: IncomingMessage): Promise<SeatClaims> => {
    const c = credential(req);
    if (!(await policyOk(c.tid))) throw new HttpError(403, "relay_not_allowed");
    return c;
  };
  const opsAuth = (req: IncomingMessage): string => {
    if (!o.opsSecret) throw new HttpError(404, "not_found");
    const tok = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
    const a = Buffer.from(tok);
    const b = Buffer.from(o.opsSecret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, "ops_auth_invalid");
    const who = String(req.headers["x-kwl-operator"] ?? "");
    if (!/^[A-Za-z0-9_.-]{2,64}$/.test(who)) throw new HttpError(400, "operator_required");
    return who;
  };

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_JSON) throw new HttpError(413, "body_too_large");
      chunks.push(c as Buffer);
    }
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
      return v as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "body_invalid");
    }
  };

  /** 追加一行登记日志并 fsync；写入失败把文件截回写入前的长度（复核 S11A-08：不留半行，下一行不会接在坏行后面）。 */
  const appendJournal = (t: TenantState, line: Buffer): void => {
    mkdirSync(t.dir, { recursive: true, mode: 0o700 });
    const fd = openSync(journalOf(t), "a", 0o600);
    let before = -1;
    try {
      before = fstatSync(fd).size;
      if (o.journalWrite) o.journalWrite(fd, line);
      else {
        let off = 0;
        while (off < line.length) off += writeSync(fd, line, off);
      }
      fsyncSync(fd);
    } catch (e) {
      try {
        if (before >= 0) ftruncateSync(fd, before);
        fsyncSync(fd);
      } catch {
        // 截不回去：该租户此后不可用（重启时按读回规则处理），避免后续登记接在坏行后面
        badTenants.add(t.tid);
      }
      throw e;
    } finally {
      closeSync(fd);
    }
  };

  const canRead = (t: TenantState, mid: string, dev: string) => !!t.matters.get(mid)?.readers.has(dev);
  const canWrite = (t: TenantState, mid: string, dev: string) => !t.matters.has(mid) || canRead(t, mid, dev);

  /** 只唤醒该事项的读者（复核 S11B-11：不再按租户广播）。 */
  const wake = (tid: string, readers: Set<string> | null) => {
    const ws = waiters.get(tid);
    if (!ws) return;
    for (const w of [...ws]) if (!readers || readers.has(w.dev)) w.done();
  };

  // 取新段与历史里只出现未被重置的段，它们都属于该事项当前的重置代数
  const entryOut = (t: TenantState) => (e: SegEntry) => ({ seq: e.seq, matter_id: e.mid, segment_id: e.sid, dev: e.dev, sha256: e.sha, size: e.size, chunks: e.chunks, gen: t.resets.get(e.mid) ?? 0 });

  /** 从 since 之后扫描：只给本设备是读者的；返回可见条目与游标（扫描到哪里）。 */
  const scan = (t: TenantState, since: number, dev: string, mid: string | null) => {
    const out: SegEntry[] = [];
    let next = since;
    for (let i = since; i < t.entries.length; i++) {
      const e = t.entries[i]!;
      next = e.seq;
      if (t.gone.has(e.seq)) continue;
      if (mid !== null && e.mid !== mid) continue;
      if (!canRead(t, e.mid, dev)) continue;
      out.push(e);
      if (out.length >= RELAY_FEED_BATCH) break;
    }
    return { out, next, more: next < t.entries.length };
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = String(req.url ?? "");
    // 按请求行原样匹配（不认查询串与编码；与分发、支持、通知服务同一做法）
    if (raw.includes("%") || raw.includes("?") || raw.includes("..")) return send(res, 404, { error: "not_found" });
    const method = req.method ?? "GET";

    const have = /^\/v1\/relay\/matters\/([^/]+)\/have$/.exec(raw);
    if (have && method === "POST") {
      const c = await device(req);
      const mid = have[1]!;
      if (!MATTER_ID_RE.test(mid)) throw new HttpError(400, "matter_invalid");
      const t = tenantOf(c.tid);
      if (!canWrite(t, mid, c.dev)) throw new HttpError(403, "not_reader");
      const b = await readJson(req);
      if (Object.keys(b).join(",") !== "cids" || !Array.isArray(b.cids) || b.cids.length < 1 || b.cids.length > RELAY_HAVE_MAX) throw new HttpError(400, "body_invalid");
      const cids = b.cids as unknown[];
      if (cids.some((x) => typeof x !== "string" || !CID_RE.test(x))) throw new HttpError(400, "cid_invalid");
      return send(res, 200, { missing: [...new Set(cids as string[])].filter((cid) => !t.chunks.has(`${mid}/${cid}`)) });
    }

    const chunk = /^\/v1\/relay\/matters\/([^/]+)\/chunks\/([^/]+)$/.exec(raw);
    if (chunk && method === "PUT") {
      const c = await device(req);
      const [mid, cid] = [chunk[1]!, chunk[2]!];
      if (!MATTER_ID_RE.test(mid) || !CID_RE.test(cid)) throw new HttpError(400, "chunk_invalid");
      const t = tenantOf(c.tid);
      if (!canWrite(t, mid, c.dev)) throw new HttpError(403, "not_reader");
      const declared = Number(req.headers["content-length"] ?? NaN);
      if (!Number.isSafeInteger(declared) || declared < 1 || declared > RELAY_CHUNK_MAX) throw new HttpError(413, "chunk_too_large");
      const k = `${mid}/${cid}`;
      if (t.chunks.has(k)) {
        // 同一块重传：幂等（读掉请求体，不再写盘）
        for await (const _ of req) void _;
        return send(res, 200, { ok: true, existed: true });
      }
      // 配额检查与预留在同一同步区段（复核 S11A-07：并发上传不会超额）；未登记字节按设备设上限
      if (t.bytes + declared > tenantMax) throw new HttpError(507, "tenant_storage_full");
      if ((t.pending.get(c.dev) ?? 0) + declared > devicePendingMax) throw new HttpError(429, "device_pending_full");
      t.bytes += declared;
      t.pending.set(c.dev, (t.pending.get(c.dev) ?? 0) + declared);
      let kept = false;
      try {
        const hash = createHash("sha256");
        const parts: Buffer[] = [];
        let size = 0;
        for await (const part of req) {
          size += (part as Buffer).length;
          if (size > declared) throw new HttpError(413, "chunk_too_large");
          hash.update(part as Buffer);
          parts.push(part as Buffer);
        }
        // 服务端按实际字节重算摘要：块名与内容不符即拒绝（内容寻址、不可变）
        if (size !== declared || hash.digest("hex") !== cid) throw new HttpError(400, "chunk_digest_mismatch");
        stillLive(t);
        // 读请求体期间同一块已由另一请求写好：按已有处理
        if (t.chunks.has(k)) return send(res, 200, { ok: true, existed: true });
        const dir = join(t.dir, "m", mid);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
        try {
          const fd = openSync(tmp, "w", 0o600);
          try {
            const body = Buffer.concat(parts);
            let off = 0;
            while (off < body.length) off += writeSync(fd, body, off);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          renameSync(tmp, join(dir, cid));
        } catch (e) {
          rmSync(tmp, { force: true });
          throw e;
        }
        fsyncPath(dir);
        t.chunks.set(k, { size, at: now(), dev: c.dev });
        kept = true;
        return send(res, 200, { ok: true, existed: false });
      } finally {
        if (!kept) {
          t.bytes -= declared;
          releasePending(t, c.dev, declared);
        }
      }
    }
    if (chunk && method === "GET") {
      const c = await device(req);
      const [mid, cid] = [chunk[1]!, chunk[2]!];
      if (!MATTER_ID_RE.test(mid) || !CID_RE.test(cid)) throw new HttpError(400, "chunk_invalid");
      const t = tenantOf(c.tid);
      // 只给读者、只给已登记段引用的块（不能借中继互传未登记的内容）
      if (!canRead(t, mid, c.dev)) throw new HttpError(403, "not_reader");
      if (!committedIn(t, mid, cid)) throw new HttpError(404, "chunk_not_found");
      const body = readFileSync(chunkPath(t, mid, cid));
      res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "content-length": body.length });
      res.end(body);
      return;
    }

    const segs = /^\/v1\/relay\/matters\/([^/]+)\/segments$/.exec(raw);
    if (segs && method === "POST") {
      const c = await device(req);
      const mid = segs[1]!;
      if (!MATTER_ID_RE.test(mid)) throw new HttpError(400, "matter_invalid");
      const t = tenantOf(c.tid);
      const b = await readJson(req);
      stillLive(t);
      // gen：客户端知道的重置代数（第四轮复核；旧客户端不带，不核对）
      const keys = Object.keys(b).sort().join(",");
      if (keys !== "blob_chunks,chunks,epoch,readers,segment_id,sha256,size" && keys !== "blob_chunks,chunks,epoch,gen,readers,segment_id,sha256,size") throw new HttpError(400, "body_invalid");
      if (b.gen !== undefined && (typeof b.gen !== "number" || !Number.isSafeInteger(b.gen) || b.gen < 0)) throw new HttpError(400, "gen_invalid");
      const sid = b.segment_id;
      if (typeof sid !== "string" || !segmentOwnedBy(sid, c.dev)) throw new HttpError(400, "segment_id_invalid");
      if (typeof b.sha256 !== "string" || !CID_RE.test(b.sha256)) throw new HttpError(400, "sha256_invalid");
      if (typeof b.size !== "number" || !Number.isSafeInteger(b.size) || b.size < 1) throw new HttpError(400, "size_invalid");
      if (!Array.isArray(b.chunks) || b.chunks.length < 1 || b.chunks.length > RELAY_MAX_SEGMENT_CHUNKS || b.chunks.some((x) => typeof x !== "string" || !CID_RE.test(x))) throw new HttpError(400, "chunks_invalid");
      if (!Array.isArray(b.blob_chunks) || b.blob_chunks.length > RELAY_MAX_BLOB_CHUNKS || b.blob_chunks.some((x) => typeof x !== "string" || !CID_RE.test(x))) throw new HttpError(400, "blob_chunks_invalid");
      if (typeof b.epoch !== "number" || !Number.isSafeInteger(b.epoch) || b.epoch < 1) throw new HttpError(400, "epoch_invalid");
      if (!Array.isArray(b.readers) || b.readers.length < 1 || b.readers.length > RELAY_MAX_READERS || b.readers.some((x) => typeof x !== "string" || !DEVICE_ID_RE.test(x)) || !uniq(b.readers as string[])) {
        throw new HttpError(400, "readers_invalid");
      }
      const readers = b.readers as string[];
      if (!readers.includes(c.dev)) throw new HttpError(400, "writer_not_reader");
      // 客户端还不知道该事项被重置过：拒收并告知当前代数（重置前的登记不能把事项在中继上重新建起来，也不让非负责人借此成为控制成员）
      const gen = t.resets.get(mid) ?? 0;
      if (b.gen !== undefined && b.gen !== gen) return send(res, 409, { error: "matter_reset", gen });
      const m = t.matters.get(mid);
      const prev = m?.segs.get(sid);
      if (prev) {
        // 同一段编号重发：内容相同即成功（结果不明后原样重发），不同即拒绝
        if (prev.sha === b.sha256 && prev.size === b.size && prev.dev === c.dev) return send(res, 200, { ok: true, seq: prev.seq, existed: true, controller: m!.controller, gen: t.resets.get(mid) ?? 0 });
        throw new HttpError(409, "segment_conflict");
      }
      if (m && !m.readers.has(c.dev)) throw new HttpError(403, "not_reader");
      // 只有控制成员能提升纪元（可一次升多级）；其他读者声明更高纪元：等控制成员的段先到（可恢复）
      if (m && b.epoch > m.epoch && c.uid !== m.controller) throw new HttpError(409, "epoch_not_established");
      for (const cid of [...(b.chunks as string[]), ...(b.blob_chunks as string[])]) if (!t.chunks.has(`${mid}/${cid}`)) throw new HttpError(409, "chunk_missing");
      // 整段摘要按块重算（不收与块对不上的登记）
      const h = createHash("sha256");
      let size = 0;
      for (const cid of b.chunks as string[]) {
        const buf = readFileSync(chunkPath(t, mid, cid));
        size += buf.length;
        h.update(buf);
      }
      if (size !== b.size || h.digest("hex") !== b.sha256) throw new HttpError(400, "segment_digest_mismatch");
      const e: SegEntry = {
        seq: t.entries.length + 1,
        mid,
        sid,
        dev: c.dev,
        uid: c.uid,
        sha: b.sha256,
        size,
        chunks: [...(b.chunks as string[])],
        blobs: [...new Set(b.blob_chunks as string[])],
        epoch: b.epoch,
        readers: [...readers],
        at: iso(),
      };
      // 先落盘（追加 + fsync），后改内存、后回复
      appendJournal(t, Buffer.from(`${JSON.stringify(e)}\n`, "utf8"));
      t.entries.push(e);
      applyEntry(t, e);
      // 登记后这些块不再计入设备的未登记字节
      for (const cid of [...e.chunks, ...e.blobs]) {
        const info = t.chunks.get(`${mid}/${cid}`);
        if (info?.dev) {
          releasePending(t, info.dev, info.size);
          info.dev = null;
        }
      }
      // 唤醒该事项的其他读者（写入设备自己不用醒）
      wake(c.tid, new Set([...t.matters.get(mid)!.readers].filter((d) => d !== c.dev)));
      // 回告控制成员（复核 S11B-19：客户端据此判断本机能否调整成员、轮换密钥）
      return send(res, 200, { ok: true, seq: e.seq, existed: false, controller: t.matters.get(mid)!.controller, gen: t.resets.get(mid) ?? 0 });
    }

    const feed = /^\/v1\/relay\/changes\/(\d{1,15})(\/wait)?$/.exec(raw);
    if (feed && method === "GET") {
      const c = await device(req);
      const t = tenantOf(c.tid);
      const since = Number(feed[1]);
      if (!Number.isSafeInteger(since) || since > t.entries.length) throw new HttpError(400, "cursor_invalid");
      let r = scan(t, since, c.dev, null);
      const ws = waiters.get(c.tid) ?? new Set();
      const mine = [...ws].filter((w) => w.dev === c.dev).length;
      // 长轮询：本设备暂时没有新段，等到该设备是读者的事项有新登记或 25 秒；挂起数有上限（复核 S11A-15），超出即立即返回
      if (r.out.length === 0 && !r.more && feed[2] && mine < RELAY_WAITERS_PER_DEVICE && ws.size < RELAY_WAITERS_PER_TENANT) {
        waiters.set(c.tid, ws);
        await new Promise<void>((resolve) => {
          // 客户端断开看响应的 close（请求的 close 在请求体读完时就会触发）
          const w = {
            dev: c.dev,
            done: () => {
              clearTimeout(timer);
              ws.delete(w);
              res.off("close", w.done);
              resolve();
            },
          };
          const timer = setTimeout(w.done, waitMs);
          ws.add(w);
          res.once("close", w.done);
        });
        if (res.destroyed) return;
        if (tenants.get(c.tid) !== t) throw new HttpError(410, "tenant_purged");
        r = scan(t, r.next, c.dev, null);
      }
      // 不回全所登记总数（复核 S11A-12）
      return send(res, 200, { items: r.out.map(entryOut(t)), next: r.next, more: r.more, instance, server_time: iso() });
    }

    const hist = /^\/v1\/relay\/matters\/([^/]+)\/segments\/(\d{1,15})$/.exec(raw);
    if (hist && method === "GET") {
      const c = await device(req);
      const mid = hist[1]!;
      if (!MATTER_ID_RE.test(mid)) throw new HttpError(400, "matter_invalid");
      const t = tenantOf(c.tid);
      // 中继上还没有该事项：如实回 404（非负责人的设备据此等负责人先登记；复核 S11A-04）；重置前的读者另得到重置代数（被重置过的事项 ≥ 1）
      if (!t.matters.has(mid)) return send(res, 404, t.resetReaders.get(mid)?.has(c.dev) ? { error: "matter_unknown", gen: t.resets.get(mid) ?? 0 } : { error: "matter_unknown" });
      if (!canRead(t, mid, c.dev)) throw new HttpError(403, "not_reader");
      const since = Number(hist[2]);
      if (!Number.isSafeInteger(since) || since > t.entries.length) throw new HttpError(400, "cursor_invalid");
      const r = scan(t, since, c.dev, mid);
      return send(res, 200, { items: r.out.map(entryOut(t)), next: r.next, more: r.more, instance, controller: t.matters.get(mid)!.controller, gen: t.resets.get(mid) ?? 0 });
    }

    // ─── 运营：律所退约时按租户整体删除；中继上的事项状态异常时按事项重置（先记访问审计，记不进去即不删） ───
    const opsMatter = /^\/v1\/relay\/ops\/tenants\/([A-Za-z0-9_-]{1,80})\/matters\/([^/]+)$/.exec(raw);
    if (opsMatter && method === "DELETE") {
      const who = opsAuth(req);
      const [tid, mid] = [opsMatter[1]!, opsMatter[2]!];
      if (!MATTER_ID_RE.test(mid)) throw new HttpError(400, "matter_invalid");
      const t = tenantOf(tid);
      let bytes = 0;
      for (const [k, cinfo] of t.chunks) if (k.startsWith(`${mid}/`)) bytes += cinfo.size;
      access({ at: iso(), action: "matter_reset", operator: who, tid, mid, removed_bytes: bytes, result: "ok" });
      const rec: ResetRecord = { k: "reset", mid, at: iso(), operator: who };
      appendJournal(t, Buffer.from(`${JSON.stringify(rec)}\n`, "utf8"));
      for (const x of t.entries) if (x.mid === mid) t.gone.add(x.seq);
      noteReset(t, mid);
      for (const [k, cinfo] of [...t.chunks]) {
        if (!k.startsWith(`${mid}/`)) continue;
        t.chunks.delete(k);
        t.bytes -= cinfo.size;
        releasePending(t, cinfo.dev, cinfo.size);
      }
      rmSync(join(t.dir, "m", mid), { recursive: true, force: true });
      return send(res, 200, { ok: true, removed_bytes: bytes });
    }
    const opsTenant = /^\/v1\/relay\/ops\/tenants\/([A-Za-z0-9_-]{1,80})$/.exec(raw);
    if (opsTenant && method === "DELETE") {
      const who = opsAuth(req);
      const tid = opsTenant[1]!;
      const t = tenants.get(tid);
      const bytes = t?.bytes ?? 0;
      access({ at: iso(), action: "tenant_purge", operator: who, tid, removed_bytes: bytes, result: "ok" });
      // 先标记“删除中”，在途请求读完请求体后放弃（复核 S11A-09）
      if (t) t.purging = true;
      tenants.delete(tid);
      badTenants.delete(tid);
      rmSync(tenantDir(tid), { recursive: true, force: true });
      wake(tid, null);
      return send(res, 200, { ok: true, removed_bytes: bytes });
    }

    send(res, 404, { error: "not_found" });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (e instanceof HttpError) {
        // 拒绝时不读剩余请求体：直接回复并关闭连接（避免为一个被拒绝的大块继续收字节）
        res.setHeader("connection", "close");
        return send(res, e.status, { error: e.code });
      }
      send(res, 500, { error: "relay_error" });
    });
  });
  server.on("close", () => {
    clearInterval(timer);
    for (const tid of [...waiters.keys()]) wake(tid, null);
  });
  return Object.assign(server, {
    sweep,
    instance,
    tenant(tid: string) {
      const t = tenants.get(tid);
      if (!t) return null;
      return {
        entries: t.entries.map((e) => structuredClone(e)),
        bytes: t.bytes,
        chunkFiles: [...t.chunks.keys()],
        controller: (mid: string) => t.matters.get(mid)?.controller ?? null,
      };
    },
  });
}
