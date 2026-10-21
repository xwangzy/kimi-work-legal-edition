/**
 * 云端对象存储接口（v9.3 A-11；调研 Y2 §3.11、§3.13“对象存储 + 服务端加密 + 生命周期规则”）。
 *
 * - `fsBlobStore(dir)`：本地目录（开发、测试、单机试点；先写临时文件、fsync、再改名）；
 * - `s3BlobStore(o)`：S3 兼容接口（华为云 OBS、阿里云 OSS 等均提供），AWS 签名第 4 版（自写，不引 SDK）；
 *   **每个对象都要求服务端加密**（SSE-KMS 带密钥编号，或 SSE-S3），桶策略另应拒收不带加密头的写入（部署文档）；只走 HTTPS（只信给定 CA 时另给 ca）。
 *   生命周期规则（到期自动删除）是桶配置，由 IaC 设；服务自己的到期删除照旧执行，生命周期只是兜底。
 *
 * 键名只允许 `[A-Za-z0-9._/-]`、不得以 / 开头、不得含 `..`——调用方的编号直接拼进键名，不能借此跳出前缀。
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { dirname, join, relative, sep } from "node:path";

export interface BlobInfo {
  key: string;
  size: number;
  /** 最后修改（毫秒）。 */
  mtime: number;
}

/** 对象的一个版本（ListObjectVersions）；deleteMarker = 删除标记（版本化桶上的“删除”只加标记）。 */
export interface BlobVersion {
  key: string;
  versionId: string;
  latest: boolean;
  deleteMarker: boolean;
}

/** 一条启用的生命周期规则（只列启用的）。 */
export interface LifecycleRule {
  id: string;
  /** 过滤前缀（整桶键名，含存储前缀）；空串 = 整桶。 */
  prefix: string;
  /** 带标签过滤（只作用于打了标签的对象；本服务不打标签）。 */
  tagged: boolean;
  /** 当前版本 n 天后到期（版本化桶上是加删除标记）。 */
  expirationDays: number | null;
  /** 非当前版本 n 天后真正删除。 */
  noncurrentDays: number | null;
}

/** 桶的防护配置（版本控制、对象锁、生命周期），启动核对用（复核 RC-A-01、RC-A-04）。 */
export interface BucketGuards {
  versioning: "Enabled" | "Suspended" | null;
  objectLock: boolean;
  rules: LifecycleRule[];
}

export interface BlobStore {
  readonly kind: "fs" | "s3";
  /** 本存储在桶里的键名前缀（如 "prod/"；没有为空串）：生命周期规则按整桶键名过滤，核对时要拼上。 */
  readonly keyPrefix?: string;
  put(key: string, data: Buffer): Promise<void>;
  /** 只在键不存在时写入（S3 条件写 If-None-Match: *）：已存在返回 "exists"，不覆盖（复核 RC-A-01）。 */
  putIfAbsent?(key: string, data: Buffer): Promise<"created" | "exists">;
  /** 列出前缀下全部版本与删除标记（只有版本化的对象存储有）。 */
  listVersions?(prefix: string): Promise<BlobVersion[]>;
  /** 读桶的版本控制、对象锁与生命周期规则。 */
  guards?(): Promise<BucketGuards>;
  /** 不存在返回 null。 */
  get(key: string): Promise<Buffer | null>;
  /** 不存在也算成功。 */
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<BlobInfo[]>;
  /** 桶的生命周期规则（只有对象存储有；读不到规则为 rules: 0）。 */
  lifecycle?(): Promise<{ rules: number; expirationDays: number[] }>;
}

const KEY_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\/-]{1,512}$/;
export function checkKey(key: string): string {
  if (!KEY_RE.test(key)) throw new Error(`对象键名不合规：${JSON.stringify(key).slice(0, 80)}`);
  return key;
}

export function fsBlobStore(dir: string): BlobStore {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pathOf = (key: string) => join(dir, ...checkKey(key).split("/"));
  const writeTmp = (p: string, data: Buffer): string => {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.tmp-${randomBytes(4).toString("hex")}`;
    try {
      const fd = openSync(tmp, "w", 0o600);
      try {
        let off = 0;
        while (off < data.length) off += writeSync(fd, data, off);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    return tmp;
  };
  return {
    kind: "fs",
    keyPrefix: "",
    async putIfAbsent(key, data) {
      const p = pathOf(key);
      const tmp = writeTmp(p, data);
      try {
        // 硬链接到目标名：目标已存在即失败（原子，不覆盖）
        linkSync(tmp, p);
        return "created";
      } catch (e: any) {
        if (e?.code === "EEXIST") return "exists";
        throw e;
      } finally {
        rmSync(tmp, { force: true });
      }
    },
    async put(key, data) {
      const p = pathOf(key);
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      const tmp = `${p}.tmp-${randomBytes(4).toString("hex")}`;
      try {
        const fd = openSync(tmp, "w", 0o600);
        try {
          let off = 0;
          while (off < data.length) off += writeSync(fd, data, off);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, p);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    },
    async get(key) {
      try {
        const p = pathOf(key);
        // 只读普通文件、不跟随符号链接（复核 RB16A-11，与支持服务的 readRegular 同一口径，复核 S9B-09）
        if (!lstatSync(p).isFile()) return null;
        return readFileSync(p);
      } catch {
        return null;
      }
    },
    async delete(key) {
      rmSync(pathOf(key), { force: true });
    },
    async list(prefix) {
      if (prefix !== "") checkKey(prefix.replace(/\/$/, "") || "x");
      const out: BlobInfo[] = [];
      const walk = (d: string) => {
        let entries: import("node:fs").Dirent[];
        try {
          entries = readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile() && !/\.tmp-[0-9a-f]{8}$/.test(e.name)) {
            const key = relative(dir, p).split(sep).join("/");
            if (!key.startsWith(prefix)) continue;
            const st = statSync(p);
            out.push({ key, size: st.size, mtime: st.mtimeMs });
          }
        }
      };
      walk(dir);
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
  };
}

// ─── S3 兼容（AWS 签名第 4 版） ───

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3BlobStoreOptions {
  /** https://obs.cn-north-4.myhuaweicloud.com 之类；测试可用 http://127.0.0.1（allowInsecureForTest）。 */
  endpoint: string;
  bucket: string;
  region: string;
  credentials: S3Credentials;
  /** 服务端加密：KMS（带密钥编号，生产）或 SSE-S3。 */
  sse: { kmsKeyId: string } | "AES256";
  /** 键名前缀（同一桶分服务）。 */
  prefix?: string;
  /** 只信这个 CA（私有化部署）；缺省用系统根。 */
  ca?: string;
  allowInsecureForTest?: boolean;
  timeoutMs?: number;
  now?: () => number;
}

const sha256hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s, "utf8").digest();
/** S3 的 URI 编码：除 A–Z a–z 0–9 - _ . ~ 外按 UTF-8 百分号编码；路径里的 / 保留。 */
export const s3Encode = (s: string, keepSlash: boolean) =>
  [...Buffer.from(s, "utf8")]
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === "/")) return c;
      return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");

/**
 * 按 AWS 签名第 4 版给请求签名，返回要加的请求头（含 authorization）。headers 的键须为小写；payloadHash 为请求体 SHA-256 十六进制。
 */
export function signV4(o: {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service?: string;
  credentials: S3Credentials;
  amzDate: string;
}): Record<string, string> {
  const service = o.service ?? "s3";
  const date = o.amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...o.headers, host: o.host, "x-amz-date": o.amzDate, "x-amz-content-sha256": o.payloadHash };
  if (o.credentials.sessionToken) headers["x-amz-security-token"] = o.credentials.sessionToken;
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((h) => `${h}:${String(headers[h]).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = Object.keys(o.query)
    .sort()
    .map((k) => `${s3Encode(k, false)}=${s3Encode(o.query[k]!, false)}`)
    .join("&");
  const canonical = [o.method, s3Encode(o.path, true), canonicalQuery, canonicalHeaders, signedHeaders, o.payloadHash].join("\n");
  const scope = `${date}/${o.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", o.amzDate, scope, sha256hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${o.credentials.secretAccessKey}`, date), o.region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign, "utf8").digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${o.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

export class BlobStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function s3BlobStore(o: S3BlobStoreOptions): BlobStore {
  const base = new URL(o.endpoint);
  const secure = base.protocol === "https:";
  if (!secure && !(o.allowInsecureForTest && base.hostname === "127.0.0.1")) throw new Error("对象存储只能经 HTTPS 访问");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(o.bucket)) throw new Error("桶名不合规");
  const prefix = o.prefix ? `${checkKey(o.prefix.replace(/\/+$/, ""))}/` : "";
  const now = o.now ?? Date.now;
  const sseHeaders: Record<string, string> =
    o.sse === "AES256" ? { "x-amz-server-side-encryption": "AES256" } : { "x-amz-server-side-encryption": "aws:kms", "x-amz-server-side-encryption-aws-kms-key-id": o.sse.kmsKeyId };
  const call = (method: string, key: string | null, query: Record<string, string>, body: Buffer | null, extra: Record<string, string> = {}): Promise<{ status: number; body: Buffer; headers: Record<string, string | string[] | undefined> }> => {
    // 路径式寻址（/<桶>/<键>）：兼容私有化部署与不支持虚拟主机式的实现
    const path = `/${o.bucket}${key === null ? "" : `/${key}`}`;
    const amzDate = new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const payload = body ?? Buffer.alloc(0);
    const headers = signV4({
      method,
      host: base.host,
      path,
      query,
      headers: { ...extra, ...(body ? { "content-length": String(payload.length), "content-type": "application/octet-stream" } : {}) },
      payloadHash: sha256hex(payload),
      region: o.region,
      credentials: o.credentials,
      amzDate,
    });
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${s3Encode(k, false)}=${s3Encode(query[k]!, false)}`)
      .join("&");
    const url = `${base.protocol}//${base.host}${s3Encode(path, true)}${qs ? `?${qs}` : ""}`;
    return new Promise((resolve, reject) => {
      const req = (secure ? httpsRequest : httpRequest)(url, { method, headers, timeout: o.timeoutMs ?? 30_000, ...(secure && o.ca ? { ca: o.ca } : {}) }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
        res.on("error", () => reject(new BlobStoreError("reply_broken", "对象存储回复中断")));
      });
      req.on("timeout", () => req.destroy(new BlobStoreError("timeout", "对象存储超时")));
      req.on("error", (e) => reject(e instanceof BlobStoreError ? e : new BlobStoreError("unreachable", "连不上对象存储")));
      req.end(body ?? undefined);
    });
  };
  const errCode = (b: Buffer) => /<Code>([A-Za-z0-9]{1,64})<\/Code>/.exec(b.toString("utf8"))?.[1] ?? "unknown";
  const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const tag = (xml: string, name: string) => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
    return m ? unxml(m[1]!) : null;
  };
  const checkSse = async (key: string, r: { headers: Record<string, string | string[] | undefined> }) => {
    // 没有按要求加密（实现不支持或被代理剥掉加密头）：删掉并报错——不留未加密的对象
    const enc = String(r.headers["x-amz-server-side-encryption"] ?? "");
    if (enc !== (o.sse === "AES256" ? "AES256" : "aws:kms")) {
      await call("DELETE", `${prefix}${key}`, {}, null).catch(() => undefined);
      throw new BlobStoreError("sse_missing", "对象存储没有按要求做服务端加密");
    }
  };
  /** 列举的页数上限：到了就报错，不静默截断（复核 RC-A-07）。 */
  const MAX_PAGES = 10_000;
  return {
    kind: "s3",
    keyPrefix: prefix,
    async put(key, data) {
      const r = await call("PUT", `${prefix}${checkKey(key)}`, {}, data, sseHeaders);
      if (r.status !== 200) throw new BlobStoreError(`s3_${errCode(r.body)}`, `对象存储写入失败（${r.status}）`);
      await checkSse(key, r);
    },
    async putIfAbsent(key, data) {
      const r = await call("PUT", `${prefix}${checkKey(key)}`, {}, data, { ...sseHeaders, "if-none-match": "*" });
      if (r.status === 412) return "exists";
      if (r.status !== 200) throw new BlobStoreError(`s3_${errCode(r.body)}`, `对象存储写入失败（${r.status}）`);
      await checkSse(key, r);
      return "created";
    },
    async listVersions(p) {
      const out: BlobVersion[] = [];
      let keyMarker: string | null = null;
      let versionMarker: string | null = null;
      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES) throw new BlobStoreError("list_too_long", "对象存储版本列举超过页数上限");
        const q: Record<string, string> = { versions: "", prefix: `${prefix}${p}`, "max-keys": "1000", ...(keyMarker !== null ? { "key-marker": keyMarker } : {}), ...(versionMarker !== null ? { "version-id-marker": versionMarker } : {}) };
        const r = await call("GET", null, q, null);
        if (r.status !== 200) throw new BlobStoreError(`s3_${errCode(r.body)}`, `对象存储版本列举失败（${r.status}）`);
        const xml = r.body.toString("utf8");
        for (const m of xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
          const k = tag(m[2]!, "Key") ?? "";
          if (!k.startsWith(prefix)) continue;
          out.push({ key: k.slice(prefix.length), versionId: tag(m[2]!, "VersionId") ?? "null", latest: tag(m[2]!, "IsLatest") === "true", deleteMarker: m[1] === "DeleteMarker" });
        }
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
        keyMarker = tag(xml, "NextKeyMarker");
        versionMarker = tag(xml, "NextVersionIdMarker");
        if (!keyMarker) throw new BlobStoreError("list_broken", "对象存储版本列举没有给出下一页标记");
      }
      return out;
    },
    async guards() {
      const v = await call("GET", null, { versioning: "" }, null);
      if (v.status !== 200) throw new BlobStoreError(`s3_${errCode(v.body)}`, `读不到桶的版本控制（${v.status}）`);
      const vs = tag(v.body.toString("utf8"), "Status");
      const l = await call("GET", null, { "object-lock": "" }, null);
      if (l.status !== 200 && l.status !== 404) throw new BlobStoreError(`s3_${errCode(l.body)}`, `读不到桶的对象锁配置（${l.status}）`);
      const objectLock = l.status === 200 && tag(l.body.toString("utf8"), "ObjectLockEnabled") === "Enabled";
      const c = await call("GET", null, { lifecycle: "" }, null);
      if (c.status !== 200 && c.status !== 404) throw new BlobStoreError(`s3_${errCode(c.body)}`, `读不到桶的生命周期规则（${c.status}）`);
      return { versioning: vs === "Enabled" || vs === "Suspended" ? vs : null, objectLock, rules: c.status === 200 ? parseLifecycle(c.body.toString("utf8")) : [] };
    },
    async get(key) {
      const r = await call("GET", `${prefix}${checkKey(key)}`, {}, null);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new BlobStoreError(`s3_${errCode(r.body)}`, `对象存储读取失败（${r.status}）`);
      return r.body;
    },
    async delete(key) {
      const r = await call("DELETE", `${prefix}${checkKey(key)}`, {}, null);
      if (r.status !== 204 && r.status !== 200 && r.status !== 404) throw new BlobStoreError(`s3_${errCode(r.body)}`, `对象存储删除失败（${r.status}）`);
    },
    async lifecycle() {
      const r = await call("GET", null, { lifecycle: "" }, null);
      if (r.status === 404) return { rules: 0, expirationDays: [] };
      if (r.status !== 200) throw new BlobStoreError(`s3_${errCode(r.body)}`, `读不到桶的生命周期规则（${r.status}）`);
      const rules = parseLifecycle(r.body.toString("utf8"));
      return { rules: rules.length, expirationDays: rules.map((x) => x.expirationDays).filter((d): d is number => d !== null) };
    },
    async list(p) {
      const out: BlobInfo[] = [];
      let token: string | null = null;
      for (let page = 0; ; page++) {
        if (page >= MAX_PAGES) throw new BlobStoreError("list_too_long", "对象存储列举超过页数上限");
        const q: Record<string, string> = { "list-type": "2", prefix: `${prefix}${p}`, "max-keys": "1000", ...(token ? { "continuation-token": token } : {}) };
        const r = await call("GET", null, q, null);
        if (r.status !== 200) throw new BlobStoreError(`s3_${errCode(r.body)}`, `对象存储列举失败（${r.status}）`);
        const xml = r.body.toString("utf8");
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const k = unxml(/<Key>([\s\S]*?)<\/Key>/.exec(m[1]!)?.[1] ?? "");
          if (!k.startsWith(prefix)) continue;
          out.push({ key: k.slice(prefix.length), size: Number(/<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1] ?? 0), mtime: Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(m[1]!)?.[1] ?? "") || 0 });
        }
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
        token = unxml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "");
        if (!token) break;
      }
      return out;
    },
  };
}

/** 解析生命周期配置，只留启用的规则（前缀兼容旧写法 <Prefix> 与 <Filter><Prefix> / <Filter><And><Prefix>）。纯函数。 */
export function parseLifecycle(xml: string): LifecycleRule[] {
  const un = (x: string) => x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return [...xml.matchAll(/<Rule>([\s\S]*?)<\/Rule>/g)]
    .map((m) => m[1]!)
    .filter((r) => /<Status>Enabled<\/Status>/.test(r))
    .map((r) => {
      const days = (block: string, inner: string) => {
        const b = new RegExp(`<${block}>([\\s\\S]*?)</${block}>`).exec(r)?.[1];
        const d = b ? new RegExp(`<${inner}>(\\d+)</${inner}>`).exec(b)?.[1] : undefined;
        return d === undefined ? null : Number(d);
      };
      return {
        id: un(/<ID>([\s\S]*?)<\/ID>/.exec(r)?.[1] ?? ""),
        prefix: un(/<Prefix>([\s\S]*?)<\/Prefix>/.exec(r)?.[1] ?? ""),
        tagged: /<Tag>/.test(r),
        expirationDays: days("Expiration", "Days"),
        noncurrentDays: days("NoncurrentVersionExpiration", "NoncurrentDays"),
      };
    });
}

/** 规则的前缀与给定前缀有交集（任一方是另一方的前缀）。 */
const overlaps = (rulePrefix: string, prefix: string) => rulePrefix === "" || prefix.startsWith(rulePrefix) || rulePrefix.startsWith(prefix);

/**
 * 诊断包桶的兜底删除是否真的配上了（复核 RC-A-04）：有一条启用、不带标签、覆盖服务前缀（整桶键名）的规则，
 * 当前版本 ≤ maxDays 天到期；版本化的桶还须非当前版本 ≤ maxDays 天真正删除。纯函数。
 */
export function supportLifecycleOk(g: BucketGuards, fullPrefix: string, maxDays = 8): boolean {
  return g.rules.some(
    (r) =>
      !r.tagged &&
      (r.prefix === "" || fullPrefix.startsWith(r.prefix)) &&
      r.expirationDays !== null &&
      r.expirationDays <= maxDays &&
      (g.versioning !== "Enabled" || (r.noncurrentDays !== null && r.noncurrentDays <= maxDays)),
  );
}

/**
 * 签名账外送桶的防护（复核 RC-A-01）：须开版本控制与对象锁，且没有会作用于外送前缀的到期规则。返回问题列表（空 = 合格）。纯函数。
 */
export function archiveGuardProblems(g: BucketGuards, fullPrefix: string): string[] {
  const out: string[] = [];
  if (g.versioning !== "Enabled") out.push("桶没有开版本控制");
  if (!g.objectLock) out.push("桶没有开对象锁");
  for (const r of g.rules) if (!r.tagged && overlaps(r.prefix, fullPrefix) && (r.expirationDays !== null || r.noncurrentDays !== null)) out.push(`生命周期规则“${r.id || "未命名"}”会让外送对象到期`);
  return out;
}
