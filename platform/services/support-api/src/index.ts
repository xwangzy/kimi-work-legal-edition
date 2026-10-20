/**
 * 支持与诊断服务 v0（v9.2 §5.1 S13；调研 Y2 §3.13“律师在客户端主动生成：本地脱敏 → 预览将上传的内容 → 确认后上传；
 * 单次上传令牌、7 天后删除、访问留审计；律所策略可禁用”）。
 *
 * - `POST /v1/support/tickets`（席位令牌）：律所策略允许上传时发一张工单——工单号（律师转告支持人员）+ 单次上传令牌（10 分钟、只能用一次）；
 *   每台设备每天至多 10 张；
 * - `PUT /v1/support/packages/<工单号>`（席位令牌 + `x-kwl-upload-token` + `x-kwl-content-sha256`）：上传诊断包本体（≤ 2 MiB，
 *   摘要须与声明一致；同一工单只收一次）；
 * - 运营（`/v1/support/ops/…`，按人运营签名，v9.3 A-10）：列出（support.read）、下载（support.read）、删除（support.delete）；
 *   **每次访问都记访问审计**（哪位运营、用哪把密钥、何时、哪张工单、做了什么）；被拒的运营请求由运营守卫另记（按分钟限量）；
 * - 保存 7 天后删除（启动时与每小时清扫）；
 * - 本服务只认席位令牌与律所策略（订阅控制面），不解析诊断包内容（内容由客户端按白名单生成并自证不含事项信息）；
 *   计量与访问审计只有租户、设备编号的服务端密钥 HMAC、工单号与字节数。
 * 存储 v0 为本地目录（生产为对象存储 + 服务端加密 + 生命周期规则，见 Y2 §3.13）。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import type { GatewayFeedView } from "@zr-legal/firm-trust";
import { verifySeatToken, SeatTokenError, type SeatClaims } from "@zr-legal/seat-token";
import { OpsAuthError, type OpsGuard, type OpsPermission } from "@zr-legal/ops-auth";

export const SUPPORT_MAX_BYTES = 2 * 1024 * 1024;
export const SUPPORT_RETENTION_MS = 7 * 24 * 3600_000;
export const UPLOAD_TOKEN_TTL_MS = 10 * 60_000;
export const TICKETS_PER_DEVICE_PER_DAY = 10;
/** 工单号：SUP- + 两组 4 位（Crockford base32，无 I/L/O/U，便于电话转告）。 */
export const TICKET_RE = /^SUP-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface SupportAccessRecord {
  at: string;
  /** upload / list / download / delete / expire。 */
  action: string;
  ticket: string | null;
  /** 运营编号（运营访问时，取自核验过的签名，不是自报）或 null。 */
  operator: string | null;
  /** 运营用的密钥编号（运营访问时；丢失某把密钥后据此查它做过什么）。 */
  op_key?: string;
  tid: string | null;
  /** 设备编号的服务端 HMAC（前 16 位）。 */
  dev: string | null;
  bytes: number | null;
  result: string;
}

export interface SupportApiOptions {
  dir: string;
  keys: ReadonlyMap<string, KeyObject>;
  /** 吊销集与律所策略（support_upload）；没有订阅即一律不允许上传（失败关闭）。 */
  feed?: Pick<GatewayFeedView, "revokedDevice" | "revokedSeat" | "supportUploadAllowed"> & { refresh?: () => Promise<void> };
  /** 运营按人鉴权（v9.3 A-10，`@zr-legal/ops-auth`）：没有 = 运营接口不开放（404）。共享运营口令已停用。 */
  opsGuard?: OpsGuard;
  /** 访问审计（缺省写 <dir>/access.jsonl）。 */
  accessLog?: (r: SupportAccessRecord) => void;
  meterKey?: Buffer;
  /** 生产形态（缺省按 NODE_ENV=production）：必须给 meterKey（复核 S9B-08：重启换密钥会让待上传工单失效、审计无法跨重启关联）。 */
  production?: boolean;
  now?: () => number;
}

interface TicketMeta {
  ticket: string;
  tid: string;
  dev: string;
  issued_at: string;
  upload_token_sha256: string;
  token_expires_at: string;
  uploaded_at: string | null;
  bytes: number | null;
  content_sha256: string | null;
  expires_at: string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function newTicket(): string {
  const b = randomBytes(8);
  const s = [...b].map((x) => B32[x % 32]).join("");
  return `SUP-${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export function createSupportApi(o: SupportApiOptions): Server & { sweep(): number } {
  const now = o.now ?? Date.now;
  const iso = (t = now()) => new Date(t).toISOString();
  if (o.meterKey && o.meterKey.byteLength < 32) throw new Error("meterKey 至少 32 字节");
  if (!o.meterKey && (o.production ?? process.env.NODE_ENV === "production")) throw new Error("生产形态必须配置 meterKey（设备编号 HMAC 密钥，由 KMS 下发）");
  if ((o as { opsSecret?: unknown }).opsSecret !== undefined) throw new Error("共享运营口令已停用（v9.3 A-10）：改用 opsGuard（按人运营凭据）");
  if (o.opsGuard && o.opsGuard.audience !== "support") throw new Error("运营守卫的受众须为 support");
  const meterKey = o.meterKey ?? randomBytes(32);
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const access = o.accessLog ?? ((r: SupportAccessRecord) => appendFileSync(join(o.dir, "access.jsonl"), `${JSON.stringify(r)}\n`, { mode: 0o600 }));
  const devHash = (dev: string) => createHmac("sha256", meterKey).update(dev).digest("hex").slice(0, 16);
  /** 上传进行中的工单（复核 S9B-05：同一工单的并发 PUT 只放行一个；单实例形态，多实例生产按数据库行锁）。 */
  const uploading = new Set<string>();

  const metaPath = (t: string) => join(o.dir, `${t}.json`);
  const binPath = (t: string) => join(o.dir, `${t}.bin`);
  /** 只读普通文件（不跟随符号链接；复核 S9B-09）。 */
  const readRegular = (path: string): Buffer | null => {
    try {
      if (!lstatSync(path).isFile()) return null;
      return readFileSync(path);
    } catch {
      return null;
    }
  };
  /** 工单元数据；已到期的按不存在（复核 S9B-09：到期后、清扫前运营也取不到）。includeExpired 只供清扫。 */
  const readMeta = (t: string, includeExpired = false): TicketMeta | null => {
    if (!TICKET_RE.test(t)) return null;
    const raw = readRegular(metaPath(t));
    if (!raw) return null;
    try {
      const m = JSON.parse(raw.toString("utf8")) as TicketMeta;
      if (!includeExpired && !(Date.parse(m.expires_at) > now())) return null;
      return m;
    } catch {
      return null;
    }
  };
  /** 本设备今天已申请的工单数（按存储里的元数据计，重启不清零；复核 S9B-08）。 */
  // “每天”按北京时间换日（复核 S9B-22）
  const bjDay = (t: number) => new Date(t + 8 * 3600_000).toISOString().slice(0, 10);
  const issuedTodayCount = (tid: string, dev: string): number => {
    const day = bjDay(now());
    let n = 0;
    for (const f of readdirSync(o.dir)) {
      const m = /^(SUP-[0-9A-Z-]+)\.json$/.exec(f);
      const meta = m ? readMeta(m[1]!, true) : null;
      if (meta && meta.tid === tid && meta.dev === dev && bjDay(Date.parse(meta.issued_at)) === day) n++;
    }
    return n;
  };
  const writeAtomic = (path: string, data: Buffer | string) => {
    const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  };

  /** 删除到期的工单与包（启动时与每小时）；返回删除张数。 */
  const sweep = (): number => {
    let n = 0;
    const t = now();
    for (const f of readdirSync(o.dir)) {
      // 崩溃留下的临时文件（超过 1 小时）与没有元数据的孤立包本体一并删除（复核 S9B-09）
      if (/\.tmp-[0-9a-f]+$/.test(f) || (/^SUP-[0-9A-Z-]+\.bin$/.test(f) && !readRegular(join(o.dir, f.replace(/\.bin$/, ".json"))))) {
        try {
          if (t - lstatSync(join(o.dir, f)).mtimeMs > 3600_000) {
            rmSync(join(o.dir, f), { force: true });
            n++;
          }
        } catch {
          // 已被删除
        }
        continue;
      }
      const m = /^(SUP-[0-9A-Z-]+)\.json$/.exec(f);
      if (!m) continue;
      const meta = readMeta(m[1]!, true);
      if (!meta || Date.parse(meta.expires_at) <= t) {
        rmSync(binPath(m[1]!), { force: true });
        rmSync(metaPath(m[1]!), { force: true });
        access({ at: iso(), action: "expire", ticket: m[1]!, operator: null, tid: meta?.tid ?? null, dev: meta?.dev ?? null, bytes: meta?.bytes ?? null, result: "deleted" });
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

  /** 律所是否允许上传；不允许时按需刷新一次订阅再判（复核 S9B-07：刚开启时首个请求不误拒）。 */
  const allowed = async (tid: string): Promise<boolean> => {
    if (o.feed?.supportUploadAllowed?.(tid)) return true;
    if (!o.feed?.refresh) return false;
    await o.feed.refresh().catch(() => {});
    return !!o.feed.supportUploadAllowed?.(tid);
  };
  const seat = (req: IncomingMessage): SeatClaims => {
    const tok = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    if (!tok) throw Object.assign(new Error("seat_required"), { status: 401 });
    let c: SeatClaims;
    try {
      // 只收控制面签发的“只限支持服务”短期凭据（复核 S9B-03：通用席位令牌不交给支持域）
      c = verifySeatToken(tok, o.keys, { now: now(), audience: "support", requireAudience: true });
    } catch (e) {
      throw Object.assign(new Error(`seat_${e instanceof SeatTokenError ? e.reason : "invalid"}`), { status: 401 });
    }
    if (o.feed?.revokedDevice(c.tid, c.dev) || o.feed?.revokedSeat(c.sid)) throw Object.assign(new Error("seat_revoked"), { status: 401 });
    return c;
  };
  /** 运营请求按人核验（签名、名册、随机数、权限）；没有配置运营守卫即按不存在处理。被拒的另记访问审计（守卫内按分钟限量）。 */
  const opsAuth = (req: IncomingMessage, raw: string, perm: OpsPermission): { who: string; key: string } => {
    if (!o.opsGuard) throw Object.assign(new Error("not_found"), { status: 404 });
    try {
      const r = o.opsGuard.authorize(req.headers, { method: req.method ?? "GET", path: raw }, perm);
      return { who: r.operator, key: r.kid };
    } catch (e) {
      if (e instanceof OpsAuthError) throw Object.assign(new Error(e.code), { status: e.status });
      throw e;
    }
  };
  const readBody = async (req: IncomingMessage, max: number): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > max) throw Object.assign(new Error("package_too_large"), { status: 413 });
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = String(req.url ?? "");
    // 按请求行原样匹配（不认查询串与编码；第 8 批 dist-api 同一做法）
    if (raw.includes("%") || raw.includes("?") || raw.includes("..")) return send(res, 404, { error: "not_found" });
    const method = req.method ?? "GET";

    if (method === "POST" && raw === "/v1/support/tickets") {
      const c = seat(req);
      if (!(await allowed(c.tid))) return send(res, 403, { error: "support_upload_disabled" });
      if (issuedTodayCount(c.tid, devHash(c.dev)) >= TICKETS_PER_DEVICE_PER_DAY) return send(res, 429, { error: "too_many_tickets" });
      let ticket = newTicket();
      while (existsSync(metaPath(ticket))) ticket = newTicket();
      const token = randomBytes(32).toString("base64url");
      const t = now();
      const meta: TicketMeta = { ticket, tid: c.tid, dev: devHash(c.dev), issued_at: iso(t), upload_token_sha256: sha256(token), token_expires_at: iso(t + UPLOAD_TOKEN_TTL_MS), uploaded_at: null, bytes: null, content_sha256: null, expires_at: iso(t + SUPPORT_RETENTION_MS) };
      writeAtomic(metaPath(ticket), JSON.stringify(meta));
      return send(res, 200, { ticket, upload_token: token, token_expires_at: meta.token_expires_at, max_bytes: SUPPORT_MAX_BYTES, retention_days: 7 });
    }

    const up = /^\/v1\/support\/packages\/(SUP-[0-9A-Z]{4}-[0-9A-Z]{4})$/.exec(raw);
    if (method === "PUT" && up) {
      const c = seat(req);
      const meta = readMeta(up[1]!);
      const token = String(req.headers["x-kwl-upload-token"] ?? "");
      const declared = String(req.headers["x-kwl-content-sha256"] ?? "");
      const fail = (status: number, code: string) => {
        access({ at: iso(), action: "upload", ticket: up[1]!, operator: null, tid: c.tid, dev: devHash(c.dev), bytes: null, result: code });
        send(res, status, { error: code });
      };
      if (!meta || meta.tid !== c.tid || meta.dev !== devHash(c.dev)) return fail(404, "ticket_unknown");
      if (meta.uploaded_at) return fail(409, "ticket_used");
      const a = Buffer.from(sha256(token));
      const b = Buffer.from(meta.upload_token_sha256);
      if (!token || a.length !== b.length || !timingSafeEqual(a, b)) return fail(401, "upload_token_invalid");
      if (Date.parse(meta.token_expires_at) <= now()) return fail(401, "upload_token_expired");
      if (uploading.has(meta.ticket)) return fail(409, "ticket_used");
      uploading.add(meta.ticket);
      try {
        if (!(await allowed(c.tid))) return fail(403, "support_upload_disabled");
        const body = await readBody(req, SUPPORT_MAX_BYTES);
        if (!/^[0-9a-f]{64}$/.test(declared) || sha256(body) !== declared) return fail(400, "content_digest_mismatch");
        // 只收诊断包（复核 S9B-13）：格式相符、包内签名设备等于凭据里的设备（一台设备不能冒称另一台设备的包）
        const doc = ((): { format?: unknown; signer_device?: unknown } | null => {
          try {
            const v = JSON.parse(body.toString("utf8")) as unknown;
            return v && typeof v === "object" ? (v as { format?: unknown; signer_device?: unknown }) : null;
          } catch {
            return null;
          }
        })();
        if (!doc || doc.format !== "kwl-diagnostics/1" || doc.signer_device !== c.dev) return fail(400, "package_invalid");
        const fresh = readMeta(meta.ticket);
        if (!fresh || fresh.uploaded_at) return fail(409, "ticket_used");
        writeAtomic(binPath(meta.ticket), body);
        writeAtomic(metaPath(meta.ticket), JSON.stringify({ ...meta, uploaded_at: iso(), bytes: body.byteLength, content_sha256: declared, upload_token_sha256: "used" }));
        // 包已保存：访问审计写不进去也回 200（复核 S9B-10：否则客户端以为失败、重试得 409，中软实际已持有）
        try {
          access({ at: iso(), action: "upload", ticket: meta.ticket, operator: null, tid: c.tid, dev: meta.dev, bytes: body.byteLength, result: "ok" });
        } catch {
          // 访问审计不可用：生产形态由告警处理
        }
        return send(res, 200, { ok: true, ticket: meta.ticket, expires_at: meta.expires_at });
      } finally {
        uploading.delete(meta.ticket);
      }
    }

    // ─── 运营：列出、下载、删除（每次访问都记访问审计） ───
    if (method === "GET" && raw === "/v1/support/ops/packages") {
      const { who, key } = opsAuth(req, raw, "support.read");
      const list: Omit<TicketMeta, "upload_token_sha256">[] = [];
      for (const f of readdirSync(o.dir)) {
        const m = /^(SUP-[0-9A-Z-]+)\.json$/.exec(f);
        const meta = m ? readMeta(m[1]!) : null;
        if (meta?.uploaded_at) {
          const { upload_token_sha256: _t, ...rest } = meta;
          list.push(rest);
        }
      }
      access({ at: iso(), action: "list", ticket: null, operator: who, op_key: key, tid: null, dev: null, bytes: null, result: `ok:${list.length}` });
      return send(res, 200, { packages: list });
    }
    const op = /^\/v1\/support\/ops\/packages\/(SUP-[0-9A-Z]{4}-[0-9A-Z]{4})$/.exec(raw);
    if (op && (method === "GET" || method === "DELETE")) {
      const { who, key } = opsAuth(req, raw, method === "GET" ? "support.read" : "support.delete");
      const meta = readMeta(op[1]!);
      if (!meta?.uploaded_at) {
        access({ at: iso(), action: method === "GET" ? "download" : "delete", ticket: op[1]!, operator: who, op_key: key, tid: null, dev: null, bytes: null, result: "not_found" });
        return send(res, 404, { error: "not_found" });
      }
      // 运营操作先记访问审计、记不进去即不执行（复核 S9B-10）
      if (method === "DELETE") {
        access({ at: iso(), action: "delete", ticket: meta.ticket, operator: who, op_key: key, tid: meta.tid, dev: meta.dev, bytes: meta.bytes, result: "ok" });
        rmSync(binPath(meta.ticket), { force: true });
        rmSync(metaPath(meta.ticket), { force: true });
        return send(res, 200, { ok: true });
      }
      const body = readRegular(binPath(meta.ticket));
      if (!body) return send(res, 404, { error: "not_found" });
      access({ at: iso(), action: "download", ticket: meta.ticket, operator: who, op_key: key, tid: meta.tid, dev: meta.dev, bytes: body.byteLength, result: "ok" });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": body.byteLength,
        "x-kwl-content-sha256": meta.content_sha256 ?? "",
        "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename="${meta.ticket}.json"`,
      });
      res.end(body);
      return;
    }
    send(res, 404, { error: "not_found" });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      const status = (e as { status?: number })?.status ?? 500;
      if (res.headersSent) res.destroy();
      else send(res, status, { error: status === 500 ? "support_error" : (e as Error).message });
    });
  });
  server.on("close", () => clearInterval(timer));
  return Object.assign(server, { sweep });
}
