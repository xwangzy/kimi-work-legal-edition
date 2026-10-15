/**
 * 通知与提醒服务 v0（第 10 批；v9 #51、K7“期限提醒云端调度、与 Agent 定时分开——关机不漏提醒”；v9.2 §5.1 S9；调研 Y2 §3.9）。
 *
 * 云端只知道**触发时间与推送目标**：每条提醒 = 触发时刻 + 每台接收设备一份密文（期限类型、事项代号、文案在律师电脑上
 * 用接收设备的 X25519 公钥加密、并由发出设备签名；本服务不解析、也解不开）+ 投递状态。
 *
 * - `PUT /v1/reminders/<编号>`：新建或以更高版本替换（只有同一成员可以改）；
 * - `DELETE /v1/reminders/<编号>`：撤销（同一成员）；不存在也回成功（客户端重试幂等）；
 * - `GET /v1/notify/due`：本设备已到时、尚未确认收到的提醒（按触发时刻，每次至多 50 条）；
 * - `POST /v1/notify/ack`：确认收到（按编号 + 版本）。
 * 凭据只收控制面签发的**只限通知服务**的短期凭据（受众 notify；通用席位令牌不交给通知域，与支持服务同一做法）。
 * 保存期：触发后 7 天删除（启动时与每小时清扫）；接收设备被吊销的，其密文随清扫删除、也取不到。
 *
 * v0 偏离（如实）：投递为设备轮询（客户端在线时每分钟一次，经出站闸门），不是 Y2 写的 SSE/WebSocket 长连接——
 * 闸门通道只有一问一答的固定形状请求；准时度 = 轮询间隔。存储为本地目录里的一份状态文件（生产为 PostgreSQL 调度表 +
 * 延迟队列 + 主备选主，Y2 §3.9）。
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, fsyncSync, openSync, closeSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import type { GatewayFeedView } from "@zr-legal/firm-trust";
import { verifySeatToken, SeatTokenError, type SeatClaims } from "@zr-legal/seat-token";

export const REMINDER_ID_RE = /^rmd_[0-9a-f]{24}$/;
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
/** 触发时刻只到分钟（UTC ISO，秒与毫秒为 0）。 */
export const FIRE_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;
/** 单份密文上限（base64url 字符数；提醒明文 ≤ 2 KiB，加签名与封装远小于此）。 */
export const NOTIFY_MAX_CT_CHARS = 8192;
export const NOTIFY_MAX_TARGETS = 50;
export const NOTIFY_DUE_BATCH = 50;
export const NOTIFY_RETENTION_MS = 7 * 24 * 3600_000;
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
interface State {
  v: 1;
  reminders: StoredReminder[];
  /** `${tid}\0${uid}\0${北京日}` → 次数。 */
  writes: Record<string, number>;
}

export interface NotifyApiOptions {
  dir: string;
  keys: ReadonlyMap<string, KeyObject>;
  /** 吊销集（没有订阅也照常工作：凭据本身有效期只有数小时）。 */
  feed?: Pick<GatewayFeedView, "revokedDevice" | "revokedSeat">;
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

export function createNotifyApi(o: NotifyApiOptions): Server & { sweep(): number; snapshot(): StoredReminder[] } {
  const now = o.now ?? Date.now;
  const iso = (t = now()) => new Date(t).toISOString();
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const statePath = join(o.dir, "reminders.json");
  const byKey = new Map<string, StoredReminder>();
  let writes: Record<string, number> = {};
  const key = (tid: string, id: string) => `${tid}\u0000${id}`;

  // 读回：坏文件拒绝启动（不静默丢掉律所的提醒）
  try {
    const raw = readFileSync(statePath, "utf8");
    const s = JSON.parse(raw) as State;
    if (s?.v !== 1 || !Array.isArray(s.reminders)) throw new Error("通知服务状态文件格式不符");
    for (const r of s.reminders) byKey.set(key(r.tid, r.id), r);
    writes = s.writes && typeof s.writes === "object" ? s.writes : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }

  /** 原子落盘（临时文件 + fsync + 改名）；回复之前完成——回了成功就不会因重启丢失。 */
  const persist = () => {
    const today = bjDay(now());
    for (const k of Object.keys(writes)) if (!k.endsWith(`\u0000${today}`)) delete writes[k];
    const state: State = { v: 1, reminders: [...byKey.values()], writes };
    const tmp = `${statePath}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, statePath);
  };

  const revoked = (tid: string, dev: string) => !!o.feed?.revokedDevice(tid, dev);

  /** 删除触发已过 7 天的提醒与被吊销设备的密文；返回删除条数。 */
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

  const countWrite = (tid: string, uid: string) => {
    const k = `${tid}\u0000${uid}\u0000${bjDay(now())}`;
    const n = (writes[k] ?? 0) + 1;
    if (n > NOTIFY_WRITES_PER_MEMBER_PER_DAY) throw new HttpError(429, "too_many_writes");
    writes[k] = n;
  };

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
      if (cur && cur.owner !== c.uid) throw new HttpError(403, "not_owner");
      if (cur && b.version < cur.version) throw new HttpError(409, "version_stale");
      if (cur && b.version === cur.version) {
        // 同一版本重发：内容相同即成功（客户端重试），不同即拒绝（版本号只能对应一份内容）
        const same = cur.fire_at === b.fire_at && Object.keys(cur.targets).length === b.targets.size && [...b.targets].every(([d, ct]) => cur.targets[d]?.ct === ct);
        if (!same) throw new HttpError(409, "version_conflict");
        return send(res, 200, { ok: true, version: cur.version, unchanged: true });
      }
      for (const dev of b.targets.keys()) if (revoked(c.tid, dev)) throw new HttpError(400, "target_revoked");
      if (!cur) {
        let n = 0;
        for (const r of byKey.values()) if (r.tid === c.tid) n++;
        if (n >= NOTIFY_MAX_PER_TENANT) throw new HttpError(429, "tenant_limit");
      }
      countWrite(c.tid, c.uid);
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
      try {
        persist();
      } catch (e) {
        // 写盘失败：回滚内存，回 500（客户端稍后重试）
        if (cur) byKey.set(k, cur);
        else byKey.delete(k);
        throw e;
      }
      return send(res, 200, { ok: true, version: next.version, targets: b.targets.size });
    }
    if (one && method === "DELETE") {
      const c = credential(req);
      const k = key(c.tid, one[1]!);
      const cur = byKey.get(k);
      if (!cur) return send(res, 200, { ok: true, existed: false });
      if (cur.owner !== c.uid) throw new HttpError(403, "not_owner");
      byKey.delete(k);
      try {
        persist();
      } catch (e) {
        byKey.set(k, cur);
        throw e;
      }
      return send(res, 200, { ok: true, existed: true });
    }

    if (method === "GET" && raw === "/v1/notify/due") {
      const c = credential(req);
      const t = now();
      const due: { id: string; version: number; fire_at: string; ct: string }[] = [];
      for (const r of byKey.values()) {
        if (r.tid !== c.tid) continue;
        const tg = r.targets[c.dev];
        if (!tg || tg.delivered_at || Date.parse(r.fire_at) > t) continue;
        due.push({ id: r.id, version: r.version, fire_at: r.fire_at, ct: tg.ct });
      }
      due.sort((a, b) => a.fire_at.localeCompare(b.fire_at) || a.id.localeCompare(b.id));
      return send(res, 200, { items: due.slice(0, NOTIFY_DUE_BATCH), more: due.length > NOTIFY_DUE_BATCH, server_time: iso(t) });
    }

    if (method === "POST" && raw === "/v1/notify/ack") {
      const c = credential(req);
      const b = await readJson(req);
      if (Object.keys(b).join(",") !== "items" || !Array.isArray(b.items) || b.items.length < 1 || b.items.length > NOTIFY_DUE_BATCH) throw new HttpError(400, "body_invalid");
      const at = iso();
      const changed: { r: StoredReminder; dev: string }[] = [];
      for (const it of b.items as unknown[]) {
        const x = it as Record<string, unknown> | null;
        if (!x || typeof x.id !== "string" || !REMINDER_ID_RE.test(x.id) || typeof x.version !== "number") throw new HttpError(400, "body_invalid");
        const r = byKey.get(key(c.tid, x.id));
        // 只确认当前版本（旧版本的确认不能把新版本标成已送达）
        const tg = r && r.version === x.version ? r.targets[c.dev] : undefined;
        if (r && tg && !tg.delivered_at) {
          tg.delivered_at = at;
          changed.push({ r, dev: c.dev });
        }
      }
      if (changed.length > 0) {
        try {
          persist();
        } catch (e) {
          for (const { r, dev } of changed) if (r.targets[dev]) r.targets[dev]!.delivered_at = null;
          throw e;
        }
      }
      return send(res, 200, { ok: true, acked: changed.length });
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
  return Object.assign(server, { sweep, snapshot: () => [...byKey.values()].map((r) => structuredClone(r)) });
}
