/**
 * 通知与提醒服务 v0（第 10 批；v9 #51、K7“期限提醒云端调度、与 Agent 定时分开——关机不漏提醒”；v9.2 §5.1 S9；调研 Y2 §3.9）。
 *
 * 云端只知道**触发时刻与推送目标**：每条提醒 = 触发时刻 + 每台接收设备一份密文（期限类型、事项代号、文案在律师电脑上
 * 用接收设备的 X25519 公钥加密、填充到固定长度、并由发出设备签名；本服务不解析、也解不开）+ 投递状态。
 * 另存（如实，复核 S10A-08）：建立者成员编号（只有同一成员能改与撤销）、版本号与最后修改时刻、每成员每日写入次数。
 *
 * - `PUT /v1/reminders/<编号>`：新建或以更高版本替换；
 * - `DELETE /v1/reminders/<编号>`（请求体 `{version}`）：撤销，留**墓碑**到触发后 7 天——迟到或被重放的旧版本登记一律拒收（复核 S10A-10）；
 * - `GET /v1/notify/due`：本设备已到时、未确认、未暂缓的提醒（按触发时刻，每次至多 50 条）；
 * - `POST /v1/notify/ack`：确认收到（按编号 + 版本）；
 * - `POST /v1/notify/defer`：本设备暂时不能判断的条目（发出设备未知、提前送达等）暂缓到给定时刻再给——不堵住后面的提醒（复核 S10A-03）；
 * - 运营 `DELETE /v1/notify/ops/tenants/<租户>`（按人运营签名、权限 tenant.purge，v9.3 A-10；先记访问审计）：律所退约时整体删除（复核 S10A-15）。
 * 凭据只收控制面签发的**只限通知服务**的短期凭据（受众 notify）。生产形态必须接吊销订阅（复核 S10A-13）。
 * 保存期：触发后 7 天删除（启动时与每小时清扫）；接收设备被吊销的，其密文随清扫删除、也取不到。
 *
 * v0 偏离（如实，D-83/D-84）：投递为设备轮询（客户端在线时约每分钟一次，经出站闸门）；存储为本地目录里的一份状态文件
 * （临时文件 + fsync + 改名 + 目录 fsync，回复前完成；生产为 PostgreSQL 调度表 + 延迟队列 + 主备选主）。
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import type { GatewayFeedView } from "@zr-legal/firm-trust";
import { verifySeatToken, SeatTokenError, type SeatClaims } from "@zr-legal/seat-token";
import { OpsAuthError, type OpsGuard, type OpsPermission } from "@zr-legal/ops-auth";

export const REMINDER_ID_RE = /^rmd_[0-9a-f]{24}$/;
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** 触发时刻只到分钟（UTC ISO，秒与毫秒为 0）。 */
export const FIRE_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;
/** 单份密文上限（base64url 字符数；提醒明文填充到 2 KiB，封装后约 2.8 千字符）。 */
export const NOTIFY_MAX_CT_CHARS = 8192;
export const NOTIFY_MAX_TARGETS = 50;
export const NOTIFY_DUE_BATCH = 50;
export const NOTIFY_RETENTION_MS = 7 * 24 * 3600_000;
/** 暂缓最长 24 小时。 */
export const NOTIFY_MAX_DEFER_MS = 24 * 3600_000;
/** 每租户同时保存的提醒上限（防止一个律所撑满存储）。 */
export const NOTIFY_MAX_PER_TENANT = 20_000;
/** 每成员每天新建与改动的次数上限（按北京时间换日）。 */
export const NOTIFY_WRITES_PER_MEMBER_PER_DAY = 500;
/** 触发时刻的可接受范围：最早 1 天前（离线补发）、最晚 3 年后。 */
const FIRE_PAST_MS = 24 * 3600_000;
const FIRE_FUTURE_MS = 3 * 366 * 24 * 3600_000;
const MAX_BODY = 512 * 1024;

interface Target {
  ct: string;
  delivered_at: string | null;
  /** 本设备要求暂缓到此刻（复核 S10A-03）。 */
  defer_until?: string | null;
}
export interface StoredReminder {
  tid: string;
  id: string;
  /** 建立者（成员编号）：只有同一成员能改与撤销。 */
  owner: string;
  version: number;
  fire_at: string;
  updated_at: string;
  targets: Record<string, Target>;
}
/** 撤销墓碑：同一编号不高于此版本的登记一律拒收，到期删除。 */
interface Tombstone {
  tid: string;
  id: string;
  owner: string;
  version: number;
  expires_at: string;
}
interface State {
  v: 1;
  reminders: StoredReminder[];
  tombstones?: Tombstone[];
  /** `${tid}\0${uid}\0${北京日}` → 次数。 */
  writes: Record<string, number>;
}

export interface NotifyAccessRecord {
  at: string;
  action: "tenant_purge";
  /** 运营编号（取自核验过的签名）。 */
  operator: string;
  /** 运营用的密钥编号。 */
  op_key: string;
  tid: string;
  removed: number;
  result: string;
}

export interface NotifyApiOptions {
  dir: string;
  keys: ReadonlyMap<string, KeyObject>;
  /** 吊销集；生产形态必须提供（复核 S10A-13：否则被吊销的设备在凭据有效期内仍能取提醒）。 */
  feed?: Pick<GatewayFeedView, "revokedDevice" | "revokedSeat">;
  /** 运营按人鉴权（v9.3 A-10，`@zr-legal/ops-auth`；启用“按租户整体删除”）：没有 = 运营接口不开放（404）。共享运营口令已停用。 */
  opsGuard?: OpsGuard;
  /** 运营访问审计（缺省写 <dir>/access.jsonl）。 */
  accessLog?: (r: NotifyAccessRecord) => void;
  /** 生产形态（缺省按 NODE_ENV=production）：必须给 feed。 */
  production?: boolean;
  now?: () => number;
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

const bjDay = (t: number) => new Date(t + 8 * 3600_000).toISOString().slice(0, 10);
const isoOk = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** 读回的提醒逐条校验（复核 S10A-12：坏记录拒绝启动，不要等到清扫或取提醒时才出错）。 */
function validStored(r: unknown): r is StoredReminder {
  const x = r as StoredReminder;
  if (!x || typeof x !== "object" || !TENANT_RE.test(String(x.tid)) || !REMINDER_ID_RE.test(String(x.id)) || typeof x.owner !== "string") return false;
  if (!Number.isSafeInteger(x.version) || x.version < 1 || !FIRE_AT_RE.test(String(x.fire_at)) || !isoOk(x.updated_at)) return false;
  if (!x.targets || typeof x.targets !== "object") return false;
  for (const [d, t] of Object.entries(x.targets)) {
    if (!DEVICE_ID_RE.test(d) || !t || typeof t.ct !== "string" || !(t.delivered_at === null || isoOk(t.delivered_at))) return false;
    if (t.defer_until !== undefined && t.defer_until !== null && !isoOk(t.defer_until)) return false;
  }
  return true;
}
function validTomb(t: unknown): t is Tombstone {
  const x = t as Tombstone;
  return !!x && TENANT_RE.test(String(x.tid)) && REMINDER_ID_RE.test(String(x.id)) && typeof x.owner === "string" && Number.isSafeInteger(x.version) && isoOk(x.expires_at);
}

export function createNotifyApi(o: NotifyApiOptions): Server & { sweep(): number; snapshot(): StoredReminder[]; tombstones(): Tombstone[] } {
  const now = o.now ?? Date.now;
  const iso = (t = now()) => new Date(t).toISOString();
  if (!o.feed && (o.production ?? process.env.NODE_ENV === "production")) throw new Error("生产形态必须接控制面吊销订阅（feed）");
  if ((o as { opsSecret?: unknown }).opsSecret !== undefined) throw new Error("共享运营口令已停用（v9.3 A-10）：改用 opsGuard（按人运营凭据）");
  if (o.opsGuard && o.opsGuard.audience !== "notify") throw new Error("运营守卫的受众须为 notify");
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const statePath = join(o.dir, "reminders.json");
  const access = o.accessLog ?? ((r: NotifyAccessRecord) => appendFileSync(join(o.dir, "access.jsonl"), `${JSON.stringify(r)}\n`, { mode: 0o600 }));
  const byKey = new Map<string, StoredReminder>();
  const tombs = new Map<string, Tombstone>();
  let writes: Record<string, number> = {};
  const key = (tid: string, id: string) => `${tid}\u0000${id}`;

  // 崩溃留下的临时状态文件含全部密文：启动即删（复核 S10A-12：不让密文超出保存期留在磁盘上）
  for (const f of readdirSync(o.dir)) if (/^reminders\.json\.tmp-[0-9a-f]+$/.test(f)) rmSync(join(o.dir, f), { force: true });
  // 读回：坏文件或坏记录拒绝启动（不静默丢掉律所的提醒）
  try {
    const raw = readFileSync(statePath, "utf8");
    const s = JSON.parse(raw) as State;
    if (s?.v !== 1 || !Array.isArray(s.reminders)) throw new Error("通知服务状态文件格式不符");
    for (const r of s.reminders) {
      if (!validStored(r)) throw new Error("通知服务状态文件有不合格的记录");
      byKey.set(key(r.tid, r.id), r);
    }
    for (const t of s.tombstones ?? []) {
      if (!validTomb(t)) throw new Error("通知服务状态文件有不合格的墓碑");
      tombs.set(key(t.tid, t.id), t);
    }
    writes = s.writes && typeof s.writes === "object" ? s.writes : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }

  /** 原子落盘（临时文件 + fsync + 改名 + 目录 fsync）；回复之前完成。 */
  const persist = () => {
    const today = bjDay(now());
    for (const k of Object.keys(writes)) if (!k.endsWith(`\u0000${today}`)) delete writes[k];
    const state: State = { v: 1, reminders: [...byKey.values()], tombstones: [...tombs.values()], writes };
    const tmp = `${statePath}.tmp-${randomBytes(4).toString("hex")}`;
    try {
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      const fd = openSync(tmp, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, statePath);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    // 改名本身落盘要同步目录（Windows 不支持打开目录做 fsync：跳过）。改名已成功，目录同步失败不再抛出——
    // 否则调用方回滚内存而磁盘已是新状态（复核 S10A-26）
    if (process.platform !== "win32") {
      try {
        const dfd = openSync(o.dir, "r");
        try {
          fsyncSync(dfd);
        } finally {
          closeSync(dfd);
        }
      } catch {
        // 断电时可能丢失这次改名：生产形态由数据库事务保证（D-84）
      }
    }
  };

  const revoked = (tid: string, dev: string) => !!o.feed?.revokedDevice(tid, dev);

  /** 删除触发已过 7 天的提醒与到期墓碑、被吊销设备的密文；返回删除的提醒条数。 */
  const sweep = (): number => {
    const t = now();
    let n = 0;
    let changed = false;
    for (const [k, r] of byKey) {
      if (Date.parse(r.fire_at) + NOTIFY_RETENTION_MS <= t) {
        byKey.delete(k);
        n++;
        changed = true;
        continue;
      }
      for (const dev of Object.keys(r.targets)) {
        if (revoked(r.tid, dev)) {
          delete r.targets[dev];
          changed = true;
        }
      }
    }
    for (const [k, tb] of tombs) {
      if (Date.parse(tb.expires_at) <= t) {
        tombs.delete(k);
        changed = true;
      }
    }
    if (changed) persist();
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

  const credential = (req: IncomingMessage): SeatClaims => {
    const tok = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    if (!tok) throw new HttpError(401, "credential_required");
    let c: SeatClaims;
    try {
      // 只收“只限通知服务”的凭据（受众 notify）；通用席位令牌与支持凭据一律拒收
      c = verifySeatToken(tok, o.keys, { now: now(), audience: "notify", requireAudience: true });
    } catch (e) {
      throw new HttpError(401, `credential_${e instanceof SeatTokenError ? e.reason : "invalid"}`);
    }
    if (revoked(c.tid, c.dev) || o.feed?.revokedSeat(c.sid)) throw new HttpError(401, "credential_revoked");
    return c;
  };
  /** 运营请求按人核验（签名、名册、随机数、权限；v9.3 A-10）；没有配置运营守卫即按不存在处理。 */
  const opsAuth = (req: IncomingMessage, raw: string, perm: OpsPermission): { who: string; key: string } => {
    if (!o.opsGuard) throw new HttpError(404, "not_found");
    try {
      const r = o.opsGuard.authorize(req.headers, { method: req.method ?? "GET", path: raw }, perm);
      return { who: r.operator, key: r.kid };
    } catch (e) {
      if (e instanceof OpsAuthError) throw new HttpError(e.status, e.code);
      throw e;
    }
  };

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, "body_too_large");
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

  /** 租户当前占用（提醒 + 墓碑）。 */
  const tenantCount = (tid: string): number => {
    let n = 0;
    for (const r of byKey.values()) if (r.tid === tid) n++;
    for (const t of tombs.values()) if (t.tid === tid) n++;
    return n;
  };
  const writeKey = (tid: string, uid: string) => `${tid}\u0000${uid}\u0000${bjDay(now())}`;

  /** 校验并整理 PUT 的请求体（键集合固定；任何多出的字段都拒绝——除触发时刻与设备编号外云端不收明文）。 */
  const parsePut = (b: Record<string, unknown>): { fire_at: string; version: number; targets: Map<string, string> } => {
    if (Object.keys(b).sort().join(",") !== "fire_at,targets,version") throw new HttpError(400, "body_invalid");
    const fire_at = b.fire_at;
    if (typeof fire_at !== "string" || !FIRE_AT_RE.test(fire_at) || Number.isNaN(Date.parse(fire_at))) throw new HttpError(400, "fire_at_invalid");
    const ft = Date.parse(fire_at);
    if (ft < now() - FIRE_PAST_MS || ft > now() + FIRE_FUTURE_MS) throw new HttpError(400, "fire_at_out_of_range");
    const version = b.version;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new HttpError(400, "version_invalid");
    if (!Array.isArray(b.targets) || b.targets.length < 1 || b.targets.length > NOTIFY_MAX_TARGETS) throw new HttpError(400, "targets_invalid");
    const targets = new Map<string, string>();
    for (const t of b.targets as unknown[]) {
      const x = t as Record<string, unknown> | null;
      if (!x || typeof x !== "object" || Object.keys(x).sort().join(",") !== "ct,dev") throw new HttpError(400, "targets_invalid");
      if (typeof x.dev !== "string" || !DEVICE_ID_RE.test(x.dev) || targets.has(x.dev)) throw new HttpError(400, "targets_invalid");
      if (typeof x.ct !== "string" || x.ct.length < 40 || x.ct.length > NOTIFY_MAX_CT_CHARS || !/^[A-Za-z0-9_-]+$/.test(x.ct)) throw new HttpError(400, "ciphertext_invalid");
      targets.set(x.dev, x.ct);
    }
    return { fire_at, version, targets };
  };

  /** 按编号 + 版本的条目清单（ack / defer 共用）。 */
  const parseItems = (b: Record<string, unknown>, withUntil: boolean): { id: string; version: number; until?: number }[] => {
    if (Object.keys(b).join(",") !== "items" || !Array.isArray(b.items) || b.items.length < 1 || b.items.length > NOTIFY_DUE_BATCH) throw new HttpError(400, "body_invalid");
    return (b.items as unknown[]).map((it) => {
      const x = it as Record<string, unknown> | null;
      if (!x || typeof x.id !== "string" || !REMINDER_ID_RE.test(x.id) || typeof x.version !== "number" || !Number.isSafeInteger(x.version)) throw new HttpError(400, "body_invalid");
      if (!withUntil) return { id: x.id, version: x.version };
      if (!isoOk(x.until)) throw new HttpError(400, "body_invalid");
      return { id: x.id, version: x.version, until: Date.parse(x.until) };
    });
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = String(req.url ?? "");
    // 按请求行原样匹配（不认查询串与编码；与分发、支持服务同一做法）
    if (raw.includes("%") || raw.includes("?") || raw.includes("..")) return send(res, 404, { error: "not_found" });
    const method = req.method ?? "GET";

    const one = /^\/v1\/reminders\/(rmd_[0-9a-f]{24})$/.exec(raw);
    if (one && method === "PUT") {
      const c = credential(req);
      const b = parsePut(await readJson(req));
      const k = key(c.tid, one[1]!);
      const cur = byKey.get(k);
      const tomb = tombs.get(k);
      if ((cur && cur.owner !== c.uid) || (tomb && tomb.owner !== c.uid)) throw new HttpError(403, "not_owner");
      // 撤销过的版本及更早版本不再收（迟到或被重放的旧登记不能让已撤销的提醒复活）
      if (tomb && b.version <= tomb.version) throw new HttpError(409, "version_stale");
      if (cur && b.version < cur.version) throw new HttpError(409, "version_stale");
      if (cur && b.version === cur.version) {
        // 同一版本重发：内容相同即成功（客户端结果不明后原样重发），不同即拒绝（版本号只能对应一份内容）
        const same = cur.fire_at === b.fire_at && Object.keys(cur.targets).length === b.targets.size && [...b.targets].every(([d, ct]) => cur.targets[d]?.ct === ct);
        if (!same) throw new HttpError(409, "version_conflict");
        return send(res, 200, { ok: true, version: cur.version, unchanged: true });
      }
      for (const dev of b.targets.keys()) if (revoked(c.tid, dev)) throw new HttpError(400, "target_revoked");
      if (!cur && !tomb && tenantCount(c.tid) >= NOTIFY_MAX_PER_TENANT) throw new HttpError(429, "tenant_limit");
      const wk = writeKey(c.tid, c.uid);
      const prevWrites = writes[wk] ?? 0;
      if (prevWrites + 1 > NOTIFY_WRITES_PER_MEMBER_PER_DAY) throw new HttpError(429, "too_many_writes");
      const next: StoredReminder = {
        tid: c.tid,
        id: one[1]!,
        owner: c.uid,
        version: b.version,
        fire_at: b.fire_at,
        updated_at: iso(),
        targets: Object.fromEntries([...b.targets].map(([d, ct]) => [d, { ct, delivered_at: null }])),
      };
      byKey.set(k, next);
      if (tomb) tombs.delete(k);
      writes[wk] = prevWrites + 1;
      try {
        persist();
      } catch (e) {
        // 写盘失败：内存与计数一并回滚，回 500（客户端稍后重试；复核 S10A-12）
        if (cur) byKey.set(k, cur);
        else byKey.delete(k);
        if (tomb) tombs.set(k, tomb);
        if (prevWrites === 0) delete writes[wk];
        else writes[wk] = prevWrites;
        throw e;
      }
      return send(res, 200, { ok: true, version: next.version, targets: b.targets.size });
    }
    if (one && method === "DELETE") {
      const c = credential(req);
      const b = await readJson(req);
      if (Object.keys(b).join(",") !== "version" || typeof b.version !== "number" || !Number.isSafeInteger(b.version) || b.version < 1) throw new HttpError(400, "body_invalid");
      const k = key(c.tid, one[1]!);
      const cur = byKey.get(k);
      const tomb = tombs.get(k);
      if ((cur && cur.owner !== c.uid) || (tomb && tomb.owner !== c.uid)) throw new HttpError(403, "not_owner");
      // 只有为不存在的编号新建墓碑才计入每日写入次数与租户上限（复核 S10A-21：不能借撤销撑大状态文件）；
      // 撤销已有的提醒不计——撤销不能被自动重登挤占的额度挡住（复核 S10A-27）
      const fresh = !cur && !tomb;
      const wk = writeKey(c.tid, c.uid);
      const prevWrites = writes[wk] ?? 0;
      if (fresh && prevWrites + 1 > NOTIFY_WRITES_PER_MEMBER_PER_DAY) throw new HttpError(429, "too_many_writes");
      if (fresh && tenantCount(c.tid) >= NOTIFY_MAX_PER_TENANT) throw new HttpError(429, "tenant_limit");
      // 墓碑记到“触发后 7 天”（没有副本的按现在起 7 天）；同一编号只升不降
      const version = Math.max(b.version, cur?.version ?? 0, tomb?.version ?? 0);
      const expires_at = iso(Math.max(cur ? Date.parse(cur.fire_at) + NOTIFY_RETENTION_MS : 0, tomb ? Date.parse(tomb.expires_at) : 0, now() + NOTIFY_RETENTION_MS));
      const nextTomb: Tombstone = { tid: c.tid, id: one[1]!, owner: c.uid, version, expires_at };
      byKey.delete(k);
      tombs.set(k, nextTomb);
      if (fresh) writes[wk] = prevWrites + 1;
      try {
        persist();
      } catch (e) {
        if (cur) byKey.set(k, cur);
        if (tomb) tombs.set(k, tomb);
        else tombs.delete(k);
        if (prevWrites === 0) delete writes[wk];
        else writes[wk] = prevWrites;
        throw e;
      }
      return send(res, 200, { ok: true, existed: !!cur });
    }

    if (method === "GET" && raw === "/v1/notify/due") {
      const c = credential(req);
      const t = now();
      const due: { id: string; version: number; fire_at: string; ct: string }[] = [];
      for (const r of byKey.values()) {
        if (r.tid !== c.tid) continue;
        const tg = r.targets[c.dev];
        if (!tg || tg.delivered_at || Date.parse(r.fire_at) > t) continue;
        if (tg.defer_until && Date.parse(tg.defer_until) > t) continue;
        due.push({ id: r.id, version: r.version, fire_at: r.fire_at, ct: tg.ct });
      }
      due.sort((a, b) => a.fire_at.localeCompare(b.fire_at) || a.id.localeCompare(b.id));
      return send(res, 200, { items: due.slice(0, NOTIFY_DUE_BATCH), more: due.length > NOTIFY_DUE_BATCH, server_time: iso(t) });
    }

    if (method === "POST" && (raw === "/v1/notify/ack" || raw === "/v1/notify/defer")) {
      const c = credential(req);
      const isDefer = raw === "/v1/notify/defer";
      const items = parseItems(await readJson(req), isDefer);
      const at = now();
      const undo: (() => void)[] = [];
      for (const x of items) {
        const r = byKey.get(key(c.tid, x.id));
        // 只处理当前版本（旧版本的确认或暂缓不能影响新版本）
        const tg = r && r.version === x.version ? r.targets[c.dev] : undefined;
        if (!tg || tg.delivered_at) continue;
        if (isDefer) {
          const prev = tg.defer_until ?? null;
          tg.defer_until = iso(Math.min(Math.max(x.until!, at + 60_000), at + NOTIFY_MAX_DEFER_MS));
          undo.push(() => void (tg.defer_until = prev));
        } else {
          tg.delivered_at = iso(at);
          undo.push(() => void (tg.delivered_at = null));
        }
      }
      if (undo.length > 0) {
        try {
          persist();
        } catch (e) {
          for (const u of undo) u();
          throw e;
        }
      }
      return send(res, 200, isDefer ? { ok: true, deferred: undo.length } : { ok: true, acked: undo.length });
    }

    // ─── 运营：律所退约时按租户整体删除（先记访问审计，记不进去即不删；复核 S10A-15） ───
    const opsTenant = /^\/v1\/notify\/ops\/tenants\/([A-Za-z0-9_-]{1,80})$/.exec(raw);
    if (opsTenant && method === "DELETE") {
      const { who, key } = opsAuth(req, raw, "tenant.purge");
      const tid = opsTenant[1]!;
      const removedR = [...byKey].filter(([, r]) => r.tid === tid);
      const removedT = [...tombs].filter(([, t]) => t.tid === tid);
      access({ at: iso(), action: "tenant_purge", operator: who, op_key: key, tid, removed: removedR.length, result: "ok" });
      for (const [k] of removedR) byKey.delete(k);
      for (const [k] of removedT) tombs.delete(k);
      try {
        persist();
      } catch (e) {
        for (const [k, r] of removedR) byKey.set(k, r);
        for (const [k, t] of removedT) tombs.set(k, t);
        try {
          access({ at: iso(), action: "tenant_purge", operator: who, op_key: key, tid, removed: 0, result: "rolled_back:state_persist_failed" });
        } catch {
          // 访问审计不可用：生产由告警处理
        }
        throw e;
      }
      return send(res, 200, { ok: true, removed: removedR.length });
    }

    send(res, 404, { error: "not_found" });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (e instanceof HttpError) return send(res, e.status, { error: e.code });
      send(res, 500, { error: "notify_error" });
    });
  });
  server.on("close", () => clearInterval(timer));
  return Object.assign(server, {
    sweep,
    snapshot: () => [...byKey.values()].map((r) => structuredClone(r)),
    tombstones: () => [...tombs.values()].map((t) => structuredClone(t)),
  });
}

