/**
 * 共享中继服务 v0（第 11 批；v9.2 §5.1 S11 ①“事项共享密文中继”；v9 第 02 篇“团队协作：端到端加密事项共享（G1）”、
 * 第 04 篇“中继：只追加段 + 内容寻址块；设备签名写入；条件写；不保存成员名单以外的身份信息；不可解密”；调研 Y2 §3.11）。
 *
 * 中继只是律所共享文件夹之外的**另一种介质**：承载端侧 `packages/sync` 的不可变同步段与密文块。它保存的只有：
 * - 块（chunk）：每块 ≤ 4 MiB 的不透明字节，按**密文**的 SHA-256 寻址（客户端把同步段与加密块切成块再上传；
 *   明文内容的摘要不出律师电脑——块名不能被用来核对“某份已知文件在不在这个事项里”）；
 * - 段登记：匿名事项编号（随机生成的事项编号）、段编号、写入设备、段摘要与大小、组成段的块、该段引用的密文块、
 *   密钥纪元与读者设备编号（端侧从段里面向各设备的密钥包裹得出）——读者名单只用来**收窄**谁能取到密文（纵深防御）；
 *   能否解密由端侧密钥体系保证，中继没有任何事项密钥。
 *
 * 接口（凭据只收控制面签发的**只限中继**的短期凭据，受众 relay；按请求行原样匹配，不认查询串与编码）：
 * - `POST /v1/relay/matters/<事项>/have`        {cids} → 还缺哪些块（写入前查询，已有的不再上传）；
 * - `PUT  /v1/relay/matters/<事项>/chunks/<cid>` 原始字节，服务端按实际字节重算摘要，与 cid 不符即拒绝；同一块重传幂等；
 * - `POST /v1/relay/matters/<事项>/segments`     登记一段（块必须都已上传，服务端按块重算整段摘要）；同一段编号只对应一份内容；
 * - `GET  /v1/relay/changes/<游标>[/wait]`       本设备是读者的事项的新段（按序号；`/wait` 无新段时最多等 25 秒）；
 * - `GET  /v1/relay/matters/<事项>/segments/<游标>` 某事项的全部段（新加入的成员取历史）；
 * - `GET  /v1/relay/matters/<事项>/chunks/<cid>` 取块（只给该事项的读者，只给已登记段引用的块）；
 * - 运营 `DELETE /v1/relay/ops/tenants/<租户>`（运营凭据 + 操作人，先记访问审计）：律所退约时整体删除。
 *
 * 写入规则：段编号必须以 `seg_<写入设备>_` 开头（只能以自己的设备写段）；事项已存在时写入设备必须是当前读者；
 * 纪元只能持平或加一（持平时读者取并集、加一时整体替换——成员移出须轮换密钥，被移出的设备从此取不到）。
 * 律所策略（share_relay）不允许时一律拒绝（按订阅二次核对；订阅过旧按不允许）。
 *
 * v0 偏离（如实，D-90/D-91）：存储为本地目录（块文件 + 每租户一份只追加的登记日志，fsync 后才回复；生产为对象存储
 * SSE-KMS + PostgreSQL + 信令 WebSocket）；保留期不按律所策略自动删除（律所退约时运营整体删除；单个事项的团队删除指令在 G1）；
 * 没有上传但 24 小时内没被登记段引用的块按残留删除。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import type { GatewayFeedView } from "@zr-legal/firm-trust";
import { verifySeatToken, SeatTokenError, type SeatClaims } from "@zr-legal/seat-token";

/** 事项编号：`mat_` + UUID（随机生成，不含事项名或时间）。 */
export const MATTER_ID_RE = /^mat_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
export const SEGMENT_ID_RE = /^seg_[A-Za-z0-9_-]{1,280}$/;
export const CID_RE = /^[0-9a-f]{64}$/;
const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** 单块上限。 */
export const RELAY_CHUNK_MAX = 4 * 1024 * 1024;
/** 一段至多 64 块（256 MiB）。 */
export const RELAY_MAX_SEGMENT_CHUNKS = 64;
/** 一段引用的密文块至多 16384 个块（约 64 GiB 材料；大案首次同步也够用）。 */
export const RELAY_MAX_BLOB_CHUNKS = 16384;
export const RELAY_MAX_READERS = 200;
export const RELAY_FEED_BATCH = 200;
export const RELAY_HAVE_MAX = 512;
export const RELAY_WAIT_MS = 25_000;
/** 已上传、未被任何登记段引用的块：24 小时后按残留删除。 */
export const RELAY_UNCOMMITTED_TTL_MS = 24 * 3600_000;
/** 每租户存储上限（缺省 50 GiB；试点按律所规模另配）。 */
export const RELAY_DEFAULT_TENANT_BYTES = 50 * 1024 ** 3;
const MAX_JSON = 2 * 1024 * 1024;

export interface SegEntry {
  seq: number;
  mid: string;
  sid: string;
  dev: string;
  sha: string;
  size: number;
  chunks: string[];
  blobs: string[];
  epoch: number;
  readers: string[];
  at: string;
}
interface MatterState {
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
}
interface TenantState {
  tid: string;
  dir: string;
  entries: SegEntry[];
  matters: Map<string, MatterState>;
  /** `${mid}/${cid}` → 大小与上传时刻。 */
  chunks: Map<string, ChunkInfo>;
  bytes: number;
}

export interface RelayAccessRecord {
  at: string;
  action: "tenant_purge";
  operator: string;
  tid: string;
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
  opsSecret?: string;
  accessLog?: (r: RelayAccessRecord) => void;
  production?: boolean;
  now?: () => number;
  waitMs?: number;
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

/** 读回的登记逐条校验（坏记录拒绝启动）。 */
function validEntry(x: unknown): x is SegEntry {
  const e = x as SegEntry;
  if (!e || typeof e !== "object" || !Number.isSafeInteger(e.seq) || e.seq < 1) return false;
  if (!MATTER_ID_RE.test(String(e.mid)) || !SEGMENT_ID_RE.test(String(e.sid)) || !DEVICE_ID_RE.test(String(e.dev))) return false;
  if (!CID_RE.test(String(e.sha)) || !Number.isSafeInteger(e.size) || e.size < 1 || !Number.isSafeInteger(e.epoch) || e.epoch < 1 || !isoOk(e.at)) return false;
  if (!Array.isArray(e.chunks) || e.chunks.length < 1 || e.chunks.some((c) => !CID_RE.test(String(c)))) return false;
  if (!Array.isArray(e.blobs) || e.blobs.some((c) => !CID_RE.test(String(c)))) return false;
  if (!Array.isArray(e.readers) || e.readers.length < 1 || e.readers.some((d) => !DEVICE_ID_RE.test(String(d)))) return false;
  return true;
}

/** 按纪元规则合入读者（持平取并集、加一整体替换、更旧不动）。 */
function applyReaders(m: MatterState, e: SegEntry): void {
  if (e.epoch === m.epoch) for (const d of e.readers) m.readers.add(d);
  else if (e.epoch === m.epoch + 1) {
    m.epoch = e.epoch;
    m.readers = new Set(e.readers);
  }
}

export function createRelayApi(o: RelayApiOptions): Server & { sweep(): number; tenant(tid: string): { entries: SegEntry[]; bytes: number; chunkFiles: string[] } | null } {
  const now = o.now ?? Date.now;
  const iso = (t = now()) => new Date(t).toISOString();
  const production = o.production ?? process.env.NODE_ENV === "production";
  if (production && !o.feed) throw new Error("生产形态必须接控制面订阅（吊销集与律所策略）");
  if (production && o.allowAllTenants) throw new Error("生产形态不得跳过律所策略核对");
  if (o.opsSecret !== undefined && o.opsSecret.length < 16) throw new Error("opsSecret 至少 16 个字符");
  const tenantMax = o.tenantMaxBytes ?? RELAY_DEFAULT_TENANT_BYTES;
  const waitMs = o.waitMs ?? RELAY_WAIT_MS;
  mkdirSync(join(o.dir, "t"), { recursive: true, mode: 0o700 });
  const access = o.accessLog ?? ((r: RelayAccessRecord) => appendFileSync(join(o.dir, "access.jsonl"), `${JSON.stringify(r)}\n`, { mode: 0o600 }));
  const tenants = new Map<string, TenantState>();
  const waiters = new Map<string, Set<() => void>>();

  const tenantDir = (tid: string) => join(o.dir, "t", tid);
  const journalOf = (t: TenantState) => join(t.dir, "journal.jsonl");
  const chunkPath = (t: TenantState, mid: string, cid: string) => join(t.dir, "m", mid, cid);

  // ─── 读回：登记日志逐行校验（最后一行写了一半的截掉；中间有坏行拒绝启动）；块文件与登记核对 ───
  const load = (tid: string): TenantState => {
    const t: TenantState = { tid, dir: tenantDir(tid), entries: [], matters: new Map(), chunks: new Map(), bytes: 0 };
    const jp = join(t.dir, "journal.jsonl");
    if (existsSync(jp)) {
      const raw = readFileSync(jp, "utf8");
      const lines = raw.split("\n");
      const tail = lines.pop() ?? "";
      if (tail !== "") {
        // 最后一行没有换行：写入中断（没有回复过成功），截掉
        truncateSync(jp, Buffer.byteLength(raw) - Buffer.byteLength(tail));
      }
      for (const line of lines) {
        let e: unknown;
        try {
          e = JSON.parse(line);
        } catch {
          throw new Error(`中继登记日志有坏行（租户 ${tid}）`);
        }
        if (!validEntry(e) || e.seq !== t.entries.length + 1) throw new Error(`中继登记日志有不合格的记录（租户 ${tid}）`);
        t.entries.push(e);
        let m = t.matters.get(e.mid);
        if (!m) {
          m = { epoch: e.epoch, readers: new Set(e.readers), segs: new Map(), committed: new Set() };
          t.matters.set(e.mid, m);
        } else applyReaders(m, e);
        m.segs.set(e.sid, e);
        for (const c of [...e.chunks, ...e.blobs]) m.committed.add(c);
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
          t.chunks.set(`${mid}/${f}`, { size: st.size, at: st.mtimeMs });
          t.bytes += st.size;
        }
      }
    }
    for (const [mid, m] of t.matters) for (const c of m.committed) if (!t.chunks.has(`${mid}/${c}`)) throw new Error(`中继登记引用的块缺失（租户 ${tid}）`);
    return t;
  };
  for (const tid of readdirSync(join(o.dir, "t"))) {
    if (!TENANT_RE.test(tid)) throw new Error("中继目录里有不认识的租户目录");
    tenants.set(tid, load(tid));
  }
  const tenantOf = (tid: string): TenantState => {
    let t = tenants.get(tid);
    if (!t) {
      t = { tid, dir: tenantDir(tid), entries: [], matters: new Map(), chunks: new Map(), bytes: 0 };
      tenants.set(tid, t);
    }
    return t;
  };

  /** 删除超过 24 小时仍未被登记段引用的块；返回删除的块数。 */
  const sweep = (): number => {
    let n = 0;
    const t0 = now();
    for (const t of tenants.values()) {
      for (const [k, c] of t.chunks) {
        const [mid, cid] = k.split("/") as [string, string];
        if (t.matters.get(mid)?.committed.has(cid)) continue;
        if (t0 - c.at < RELAY_UNCOMMITTED_TTL_MS) continue;
        rmSync(chunkPath(t, mid, cid), { force: true });
        t.chunks.delete(k);
        t.bytes -= c.size;
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
    if (!TENANT_RE.test(c.tid) || !DEVICE_ID_RE.test(c.dev)) throw new HttpError(401, "credential_invalid");
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

  const canRead = (t: TenantState, mid: string, dev: string) => !!t.matters.get(mid)?.readers.has(dev);
  const canWrite = (t: TenantState, mid: string, dev: string) => !t.matters.has(mid) || canRead(t, mid, dev);

  const wake = (tid: string) => {
    const ws = waiters.get(tid);
    if (!ws) return;
    waiters.delete(tid);
    for (const w of ws) w();
  };

  const entryOut = (e: SegEntry) => ({ seq: e.seq, matter_id: e.mid, segment_id: e.sid, sha256: e.sha, size: e.size, chunks: e.chunks });

  /** 从 since 之后扫描：只给本设备是读者的；返回可见条目与游标（扫描到哪里）。 */
  const scan = (t: TenantState, since: number, dev: string, mid: string | null) => {
    const out: SegEntry[] = [];
    let next = since;
    for (let i = since; i < t.entries.length; i++) {
      const e = t.entries[i]!;
      next = e.seq;
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
      if (t.bytes + declared > tenantMax) throw new HttpError(507, "tenant_storage_full");
      const hash = createHash("sha256");
      const parts: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        size += (part as Buffer).length;
        if (size > RELAY_CHUNK_MAX) throw new HttpError(413, "chunk_too_large");
        hash.update(part as Buffer);
        parts.push(part as Buffer);
      }
      // 服务端按实际字节重算摘要：块名与内容不符即拒绝（内容寻址、不可变）
      if (size !== declared || hash.digest("hex") !== cid) throw new HttpError(400, "chunk_digest_mismatch");
      // 读请求体期间同一块已由另一请求写好：按已有处理（不重复计入占用）
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
      t.chunks.set(k, { size, at: now() });
      t.bytes += size;
      return send(res, 200, { ok: true, existed: false });
    }
    if (chunk && method === "GET") {
      const c = await device(req);
      const [mid, cid] = [chunk[1]!, chunk[2]!];
      if (!MATTER_ID_RE.test(mid) || !CID_RE.test(cid)) throw new HttpError(400, "chunk_invalid");
      const t = tenantOf(c.tid);
      // 只给读者、只给已登记段引用的块（不能借中继互传未登记的内容）
      if (!canRead(t, mid, c.dev)) throw new HttpError(403, "not_reader");
      if (!t.matters.get(mid)!.committed.has(cid)) throw new HttpError(404, "chunk_not_found");
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
      if (Object.keys(b).sort().join(",") !== "blob_chunks,chunks,epoch,readers,segment_id,sha256,size") throw new HttpError(400, "body_invalid");
      const sid = b.segment_id;
      // 只能以自己的设备写段（段编号以写入设备编号开头；端侧另按段内设备签名与证书链核验）
      if (typeof sid !== "string" || !SEGMENT_ID_RE.test(sid) || !sid.startsWith(`seg_${c.dev}_`)) throw new HttpError(400, "segment_id_invalid");
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
      const m = t.matters.get(mid);
      const prev = m?.segs.get(sid);
      if (prev) {
        // 同一段编号重发：内容相同即成功（结果不明后原样重发），不同即拒绝
        if (prev.sha === b.sha256 && prev.size === b.size && prev.dev === c.dev) return send(res, 200, { ok: true, seq: prev.seq, existed: true });
        throw new HttpError(409, "segment_conflict");
      }
      if (m && !m.readers.has(c.dev)) throw new HttpError(403, "not_reader");
      if (m && b.epoch > m.epoch + 1) throw new HttpError(409, "epoch_jump");
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
        sha: b.sha256,
        size,
        chunks: [...(b.chunks as string[])],
        blobs: [...new Set(b.blob_chunks as string[])],
        epoch: b.epoch,
        readers: [...readers],
        at: iso(),
      };
      // 先落盘（追加 + fsync），后改内存、后回复
      mkdirSync(t.dir, { recursive: true, mode: 0o700 });
      const fd = openSync(journalOf(t), "a", 0o600);
      try {
        const line = Buffer.from(`${JSON.stringify(e)}\n`, "utf8");
        let off = 0;
        while (off < line.length) off += writeSync(fd, line, off);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      t.entries.push(e);
      if (!m) t.matters.set(mid, { epoch: e.epoch, readers: new Set(e.readers), segs: new Map([[sid, e]]), committed: new Set([...e.chunks, ...e.blobs]) });
      else {
        applyReaders(m, e);
        m.segs.set(sid, e);
        for (const cid of [...e.chunks, ...e.blobs]) m.committed.add(cid);
      }
      wake(c.tid);
      return send(res, 200, { ok: true, seq: e.seq, existed: false });
    }

    const feed = /^\/v1\/relay\/changes\/(\d{1,15})(\/wait)?$/.exec(raw);
    if (feed && method === "GET") {
      const c = await device(req);
      const t = tenantOf(c.tid);
      const since = Number(feed[1]);
      if (!Number.isSafeInteger(since) || since > t.entries.length) throw new HttpError(400, "cursor_invalid");
      let r = scan(t, since, c.dev, null);
      if (r.out.length === 0 && !r.more && feed[2]) {
        // 长轮询：本设备暂时没有新段，等到有新登记或 25 秒
        await new Promise<void>((resolve) => {
          let set = waiters.get(c.tid);
          if (!set) waiters.set(c.tid, (set = new Set()));
          // 客户端断开看响应的 close（请求的 close 在请求体读完时就会触发）
          const done = () => {
            clearTimeout(timer);
            set!.delete(done);
            res.off("close", done);
            resolve();
          };
          const timer = setTimeout(done, waitMs);
          set.add(done);
          res.once("close", done);
        });
        if (res.destroyed) return;
        r = scan(t, r.next, c.dev, null);
      }
      return send(res, 200, { items: r.out.map(entryOut), next: r.next, more: r.more, head: t.entries.length, server_time: iso() });
    }

    const hist = /^\/v1\/relay\/matters\/([^/]+)\/segments\/(\d{1,15})$/.exec(raw);
    if (hist && method === "GET") {
      const c = await device(req);
      const mid = hist[1]!;
      if (!MATTER_ID_RE.test(mid)) throw new HttpError(400, "matter_invalid");
      const t = tenantOf(c.tid);
      if (!canRead(t, mid, c.dev)) throw new HttpError(403, "not_reader");
      const since = Number(hist[2]);
      if (!Number.isSafeInteger(since) || since > t.entries.length) throw new HttpError(400, "cursor_invalid");
      const r = scan(t, since, c.dev, mid);
      return send(res, 200, { items: r.out.map(entryOut), next: r.next, more: r.more, head: t.entries.length });
    }

    // ─── 运营：律所退约时按租户整体删除（先记访问审计，记不进去即不删） ───
    const opsTenant = /^\/v1\/relay\/ops\/tenants\/([A-Za-z0-9_-]{1,80})$/.exec(raw);
    if (opsTenant && method === "DELETE") {
      const who = opsAuth(req);
      const tid = opsTenant[1]!;
      const t = tenants.get(tid);
      const bytes = t?.bytes ?? 0;
      access({ at: iso(), action: "tenant_purge", operator: who, tid, removed_bytes: bytes, result: "ok" });
      tenants.delete(tid);
      rmSync(tenantDir(tid), { recursive: true, force: true });
      wake(tid);
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
    for (const tid of [...waiters.keys()]) wake(tid);
  });
  return Object.assign(server, {
    sweep,
    tenant(tid: string) {
      const t = tenants.get(tid);
      if (!t) return null;
      return { entries: t.entries.map((e) => structuredClone(e)), bytes: t.bytes, chunkFiles: [...t.chunks.keys()] };
    },
  });
}
