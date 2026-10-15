/**
 * 内容分发服务 v0（v9.2 §5.1 S6 法规增量包、S7 方法模板分发；Y2 §3.6–3.8 的 `dist-api`）。
 *
 * - `GET /dist/<lawdb|skills>/<stable|beta>/latest.json`：签名通道清单（由发布脚本离线签好放进存储，本服务不持内容签名私钥）；
 * - `GET /dist/<kind>/<channel>/files/<文件名>`：包文件（法规库 SQLite 与 sidecar 清单、方法模板单文件包）；
 * - 凭据 = 席位令牌（`Authorization: Bearer zst1…`，与网关同一离线验签与吊销检查，Y2 §3.7）；内容是中软产品内容、不是客户数据；
 * - 计量只记租户、设备编号的服务端密钥 HMAC、类别、通道与文件名（Y2 §3.8“下载计量只设备 ID 哈希 + 版本”），不记来源地址；
 *   设备编号是 dev_<律所>_<成员>，熵很低，无盐摘要可按成员名字典还原（复核 S8A-14），故用服务端密钥（生产在 KMS，按期轮换）；
 * - 存储 v0 为本地目录（生产为对象存储 + 版本化 + 防删除，见 Y2 §5.5 S7+S8）；文件名按白名单，不跟随符号链接。
 */
import { createHmac, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import type { GatewayFeedView } from "@zr-legal/firm-trust";
import { verifySeatToken, SeatTokenError } from "@zr-legal/seat-token";

export interface DistMeterRecord {
  at: string;
  tid: string;
  /** 设备编号的 HMAC（前 16 位十六进制），不存设备编号原文。 */
  dev: string;
  kind: string;
  channel: string;
  /** "latest" 或包文件名。 */
  file: string;
  bytes: number;
}

export interface DistApiOptions {
  /** 存储根：<dir>/<kind>/<channel>/latest.json 与 <dir>/<kind>/<channel>/files/<文件名>。 */
  dir: string;
  keys: ReadonlyMap<string, KeyObject>;
  feed?: Pick<GatewayFeedView, "revokedDevice" | "revokedSeat">;
  meter?: { append(r: DistMeterRecord): void };
  /** 计量的设备编号 HMAC 密钥（≥ 32 字节；缺省为进程内随机，重启即换）。 */
  meterKey?: Buffer;
  now?: () => number;
}

const ROUTE = /^\/dist\/(lawdb|skills)\/(stable|beta)\/(latest\.json|files\/((?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,119}))$/;
/** 单文件上限（与客户端 MAX_PACKAGE_BYTES 一致）。 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** 只读普通文件（不跟随符号链接、不读目录、超过上限按不存在处理）。 */
function readRegular(path: string): Buffer | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

export function createDistApi(o: DistApiOptions): Server {
  if (o.meterKey && o.meterKey.byteLength < 32) throw new Error("meterKey 至少 32 字节");
  const meterKey = o.meterKey ?? randomBytes(32);
  return createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://dist.invalid");
    } catch {
      return json(res, 400, { error: "bad_request" });
    }
    // 查询串、编码过的路径、点段一律不认：按请求行原样匹配白名单（URL 解析会把 files/../latest.json 归一化成清单路径）
    const rawPath = String(req.url ?? "");
    const m = url.search === "" && !rawPath.includes("%") && rawPath === url.pathname ? ROUTE.exec(rawPath) : null;
    if (!m) return json(res, 404, { error: "not_found" });
    if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
    const tok = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    if (!tok) return json(res, 401, { error: "seat_required" });
    let claims;
    try {
      claims = verifySeatToken(tok, o.keys, { now: (o.now ?? Date.now)(), audience: "dist" });
      if (o.feed?.revokedDevice(claims.tid, claims.dev)) throw new SeatTokenError("device_revoked");
      if (o.feed?.revokedSeat(claims.sid)) throw new SeatTokenError("seat_revoked");
    } catch (e) {
      return json(res, 401, { error: "seat_invalid", reason: e instanceof SeatTokenError ? e.reason : "invalid" });
    }
    const [, kind, channel, tail, file] = m;
    const path = file ? join(o.dir, kind!, channel!, "files", file) : join(o.dir, kind!, channel!, "latest.json");
    const body = readRegular(path);
    if (!body) return json(res, 404, { error: "not_found" });
    o.meter?.append({
      at: new Date((o.now ?? Date.now)()).toISOString(),
      tid: claims.tid,
      dev: createHmac("sha256", meterKey).update(claims.dev).digest("hex").slice(0, 16),
      kind: kind!,
      channel: channel!,
      file: tail === "latest.json" ? "latest" : file!,
      bytes: body.byteLength,
    });
    res.writeHead(200, {
      "content-type": file ? "application/octet-stream" : "application/json; charset=utf-8",
      // 清单短缓存（Y2 §3.8）；包文件按名不可变
      "cache-control": file ? "private, max-age=86400, immutable" : "private, max-age=60",
      "content-length": body.byteLength,
    });
    res.end(body);
  });
}
