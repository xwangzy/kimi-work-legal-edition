/**
 * 运营按人鉴权（v9.3 A-10；调研 Y2 §3.12“运营控制台：堡垒机 + 双因素 + 三权分立”）。
 *
 * 取代各云端服务的共享运营口令（opsSecret + 自报的操作人头，D-80）：
 * - **运营名册**（安全管理员签名）：每位运营人员一个运营编号（`op_` 加数字工号，不用姓名——会进律所可见的流水）、
 *   一把或几把签名**公钥**（只收公钥 PEM；私钥写错位置即拒绝）、权限清单与状态。名册绑定部署（`deployment`），有效期至多 31 天，
 *   到期须重签（漏部署的吊销也在有效期内兜底）。吊销某人 = 签发新版本名册把他标为 revoked；丢了一把密钥 = 只删掉那一把。
 *   名册版本只增：服务记下见过的最高版本与摘要，旧版本或同版本不同内容一律不认，运营接口失败关闭；每接受一版另记名册换版记录。
 *   名册签名私钥由安全管理员离线保管；名册签名公钥不得同时是某位运营人员的公钥。
 * - **运营请求签名**：每个请求用本人私钥签“部署/服务 + 方法 + 路径 + 请求体摘要 + 运营编号 + 密钥编号 + 时刻 + 随机数”；
 *   服务按名册核验（时刻偏差 ≤ 5 分钟、随机数落盘不重放、权限按接口），访问审计记到运营编号、密钥编号与名册版本。云端只存公钥。
 * - **双因素**：只留接口——名册里每人的 second_factor 目前只认 "none"；标了别的而服务没有接上核验器即拒绝（失败关闭）。
 *   目前只有“持有私钥”一种因素加运维网段，等保“两种以上鉴别技术”未满足；堡垒机、会话录像与真实双因素依赖云选型（D-106）。
 * 本包不含联网代码；云端服务（控制面、支持、中继、通知）、生产入口与运营命令行（scripts/ops-cli.mjs）共用。
 * 用例与开发用的辅助在 `@zr-legal/ops-auth/testing`。
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, signAlgOfPublicKey, signSyncWith, SoftwareSigner, verifyBytes, type SessionSigner } from "@zr-legal/keys";

/** 签名者：私钥 PEM（命令行与测试）、KeyObject，或签名者对象（将来的硬件令牌）；一律经 keys 包的签名者签（KP-02）。 */
export type OpsSigningKey = string | KeyObject | SessionSigner;
const signWith = (k: OpsSigningKey, bytes: Uint8Array): string => signSyncWith(typeof k === "string" ? k : "signSync" in k ? k : new SoftwareSigner(k), bytes);

/**
 * 权限：按接口授予。tenant.manage 开通与续订、tenant.terminate 终止订阅、activation.issue 发与作废创始开通码、
 * quota.manage 加量（含开通时附带的点数）、quota.cap 代设月度上限（只能调低）、device.revoke 吊销设备与席位、
 * support.read / support.delete 诊断包查看 / 删除、relay.reset 中继按事项重置、tenant.purge 中继与通知按租户整体删除。
 */
export const OPS_PERMISSIONS = ["tenant.read", "tenant.manage", "tenant.terminate", "activation.issue", "quota.manage", "quota.cap", "device.revoke", "support.read", "support.delete", "relay.reset", "tenant.purge"] as const;
export type OpsPermission = (typeof OPS_PERMISSIONS)[number];
/** 同一人不能兼有的权限（双人复核未做之前的职责分离，D-106）：开通租户 + 发创始开通码 = 一个人就能开出并认领一个律所。 */
export const OPS_PERMISSION_CONFLICTS: readonly (readonly [OpsPermission, OpsPermission])[] = [["tenant.manage", "activation.issue"]];
/** 服务：签名绑定到“部署/服务”（同一请求不能拿到另一个服务或另一套部署去用）。 */
export const OPS_AUDIENCES = ["control-plane", "support", "relay", "notify"] as const;
export type OpsAudience = (typeof OPS_AUDIENCES)[number];
/** 运营编号：op_ 加数字工号（不用姓名：会进律所可见、不可删的运营审计流水）。 */
export const OPERATOR_ID_RE = /^op_[0-9]{4,12}$/;
export const OPS_KEY_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
/** 部署标识（生产、预发、私有化各一个）：名册与请求签名都绑定它。 */
export const OPS_DEPLOYMENT_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const OPS_REQUEST_MAX_SKEW_MS = 5 * 60_000;
export const OPS_ROSTER_FORMAT = "kwl-ops-roster/2";
/** 名册有效期上限：到期须重签（漏部署的吊销至多在一个有效期内仍有效）。 */
export const OPS_ROSTER_MAX_TTL_MS = 31 * 24 * 3600_000;
/** 单次版本跳幅上限（防止签出一个极大的版本号把以后的版本都堵死）。 */
export const OPS_ROSTER_MAX_VERSION_JUMP = 1000;
/**
 * 运营路径：/v1/ops/…（控制面）与 /v1/<服务>/ops/…（支持、中继、通知）——生产入口按来源网段收紧用。
 * 服务逐个列出（不用通配，免得把业务路径里恰好叫 ops 的编号当成运营路径）；服务源码里出现新的运营路径而这里没列，门禁失败（ops-auth.test.ts）。
 */
export const OPS_PATH_RE = /^\/v1\/(?:(?:support|relay|notify)\/)?ops(?:\/|$)/;
const ROSTER_DOMAIN = "kwl-ops-roster-v2\n";
const REQ_DOMAIN = "kwl-ops-request-v2\n";
const MAX_OPERATORS = 500;
const MAX_KEYS = 4;
const SECOND_FACTOR_RE = /^[a-z0-9-]{1,24}$/;

export interface OpsOperatorKey {
  kid: string;
  public_key_pem: string;
  added_at: string;
}

export interface OpsOperator {
  id: string;
  status: "active" | "revoked";
  perms: OpsPermission[];
  keys: OpsOperatorKey[];
  /** 双因素方式（接口占位）：目前只认 "none"；其他值须服务接上对应核验器，否则此人一律被拒。 */
  second_factor: string;
  revoked_at?: string;
}

export interface OpsRosterBody {
  format: typeof OPS_ROSTER_FORMAT;
  /** 部署标识：服务配置的 ops.deployment 须与之相同。 */
  deployment: string;
  version: number;
  issued_at: string;
  /** 到期即不认（至多签发后 31 天）。 */
  expires_at: string;
  operators: OpsOperator[];
}

export interface SignedOpsRoster {
  body: OpsRosterBody;
  /** 名册签名密钥编号（安全管理员）。 */
  kid: string;
  sig: string;
}

const isoOk = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const keysOf = (x: object) => Object.keys(x).sort().join(",");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

/**
 * 只收公钥 PEM（复核 RA10A-01 / RA10B-01）：头尾须是 PUBLIC KEY、不能当私钥解析、是 Ed25519 或 P-256。
 * Node 的 createPublicKey 会从私钥 PEM 推导出公钥、指纹也相同——不这样卡，私钥会被当公钥收进名册或服务配置。
 */
export function isPublicKeyPem(pem: unknown): pem is string {
  if (typeof pem !== "string" || pem.length > 2000 || /PRIVATE/i.test(pem)) return false;
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(pem.trim() + "\n")) return false;
  try {
    createPrivateKey(pem);
    return false;
  } catch {
    // 解析不成私钥：正是要的
  }
  return signAlgOfPublicKey(pem) !== null;
}

/** 公钥指纹（SPKI DER 的 SHA-256 前 16 位 base64url）：安全管理员登记时与本人当面或电话核对。 */
export function opsKeyFingerprint(pem: string): string {
  return sha256(createPublicKey(pem).export({ format: "der", type: "spki" })).toString("base64url").slice(0, 16);
}

/** 名册内容逐项校验：不合规返回原因代码。 */
export function validateOpsRosterBody(x: unknown): string | null {
  const b = x as OpsRosterBody;
  if (!b || typeof b !== "object" || Array.isArray(b)) return "roster_malformed";
  if (keysOf(b) !== "deployment,expires_at,format,issued_at,operators,version") return "roster_malformed";
  if (b.format !== OPS_ROSTER_FORMAT) return "roster_format_unknown";
  if (typeof b.deployment !== "string" || !OPS_DEPLOYMENT_RE.test(b.deployment)) return "roster_malformed";
  if (!Number.isSafeInteger(b.version) || b.version < 1 || b.version > 1e9 || !isoOk(b.issued_at) || !isoOk(b.expires_at)) return "roster_malformed";
  const ttl = Date.parse(b.expires_at) - Date.parse(b.issued_at);
  if (!(ttl > 0) || ttl > OPS_ROSTER_MAX_TTL_MS) return "roster_ttl_invalid";
  if (!Array.isArray(b.operators) || b.operators.length > MAX_OPERATORS) return "roster_malformed";
  const ids = new Set<string>();
  const prints = new Set<string>();
  for (const op of b.operators) {
    if (!op || typeof op !== "object") return "roster_malformed";
    const k = keysOf(op);
    if (k !== "id,keys,perms,second_factor,status" && k !== "id,keys,perms,revoked_at,second_factor,status") return "roster_malformed";
    if (typeof op.id !== "string" || !OPERATOR_ID_RE.test(op.id) || ids.has(op.id)) return "roster_operator_invalid";
    ids.add(op.id);
    if (op.status !== "active" && op.status !== "revoked") return "roster_operator_invalid";
    if (op.revoked_at !== undefined && !isoOk(op.revoked_at)) return "roster_operator_invalid";
    if (typeof op.second_factor !== "string" || !SECOND_FACTOR_RE.test(op.second_factor)) return "roster_operator_invalid";
    if (!Array.isArray(op.perms) || op.perms.length > OPS_PERMISSIONS.length || new Set(op.perms).size !== op.perms.length) return "roster_perms_invalid";
    for (const p of op.perms) if (!(OPS_PERMISSIONS as readonly string[]).includes(p)) return "roster_perms_invalid";
    for (const [a, c] of OPS_PERMISSION_CONFLICTS) if (op.perms.includes(a) && op.perms.includes(c)) return "roster_perms_conflict";
    if (!Array.isArray(op.keys) || op.keys.length > MAX_KEYS) return "roster_keys_invalid";
    const kids = new Set<string>();
    for (const key of op.keys) {
      if (!key || typeof key !== "object" || keysOf(key) !== "added_at,kid,public_key_pem") return "roster_keys_invalid";
      if (typeof key.kid !== "string" || !OPS_KEY_ID_RE.test(key.kid) || kids.has(key.kid)) return "roster_keys_invalid";
      kids.add(key.kid);
      if (!isPublicKeyPem(key.public_key_pem) || !isoOk(key.added_at)) return "roster_keys_invalid";
      // 同一把公钥不能登记给两个人（否则一人的密钥能以两个运营编号行事）
      const fp = opsKeyFingerprint(key.public_key_pem);
      if (prints.has(fp)) return "roster_key_shared";
      prints.add(fp);
    }
  }
  return null;
}

const rosterBytes = (body: OpsRosterBody) => Buffer.from(ROSTER_DOMAIN + canonicalJson(body), "utf8");
/** 名册签名公钥：只收公钥（PEM 或 public KeyObject）。 */
const publicPemOf = (k: string | KeyObject): string | null => {
  if (typeof k === "string") return isPublicKeyPem(k) ? k : null;
  return k.type === "public" ? k.export({ format: "pem", type: "spki" }).toString() : null;
};

/** 安全管理员签发名册（运营命令行与测试用）；内容不合规即抛错。 */
export function signOpsRoster(body: OpsRosterBody, signer: { kid: string; privateKey: OpsSigningKey }): SignedOpsRoster {
  const why = validateOpsRosterBody(body);
  if (why) throw new Error(`运营名册不合规：${why}`);
  if (!OPS_KEY_ID_RE.test(signer.kid)) throw new Error("名册签名密钥编号不合规");
  return { body, kid: signer.kid, sig: signWith(signer.privateKey, rosterBytes(body)) };
}

export type OpsRosterVerdict = { ok: true; body: OpsRosterBody; digest: string } | { ok: false; reason: string };

/** 核验名册：结构、签名密钥在册且是公钥、签名有效、内容合规；digest 为待签字节的 SHA-256（十六进制）。不看时间与部署（见 fileRosterSource）。 */
export function verifyOpsRoster(doc: unknown, keys: ReadonlyMap<string, string | KeyObject>): OpsRosterVerdict {
  const d = doc as SignedOpsRoster;
  if (!d || typeof d !== "object" || Array.isArray(d) || keysOf(d) !== "body,kid,sig") return { ok: false, reason: "roster_malformed" };
  const why = validateOpsRosterBody(d.body);
  if (why) return { ok: false, reason: why };
  const key = typeof d.kid === "string" ? keys.get(d.kid) : undefined;
  if (!key) return { ok: false, reason: "roster_signer_unknown" };
  const pem = publicPemOf(key);
  if (!pem) return { ok: false, reason: "roster_signer_key_not_public" };
  const bytes = rosterBytes(d.body);
  if (!verifyBytes(pem, bytes, String(d.sig))) return { ok: false, reason: "roster_signature_invalid" };
  return { ok: true, body: d.body, digest: sha256(bytes).toString("hex") };
}

export type OpsRosterState = { ok: true; body: OpsRosterBody; digest: string } | { ok: false; reason: string };
export interface OpsRosterSource {
  current(): OpsRosterState;
}

/** 原子写（随机临时名 + O_EXCL + fsync + 改名）。 */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
function appendSynced(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * 名册来源：从文件读（生产由部署挂载为只读文件，安全管理员换新版本即生效），文件有变化或距上次核验满 30 秒即重新核验；
 * 每次运营请求都经这里取当前名册，吊销不需要重启服务。不认的情形一律返回原因（运营接口 503），不抛错、不影响业务。
 * - deployment：本服务所在部署，名册的 deployment 须相同；
 * - seenFile：见过的最高版本、摘要与名册签名公钥指纹（回滚保护）——写不进去时不认新名册；读不出（损坏）时运营接口整组 503，不自动重置；
 * - historyFile：每接受一版追加一条（版本、摘要前 16 位、签名密钥、人数），名册签名公钥换了也记一条；
 * - minVersion：新实例或数据目录重建时的版本下限（ops.min_roster_version）。
 */
export function fileRosterSource(o: {
  file: string;
  keys: ReadonlyMap<string, string | KeyObject>;
  deployment: string;
  seenFile?: string;
  historyFile?: string;
  minVersion?: number;
  now?: () => number;
  maxAgeMs?: number;
}): OpsRosterSource {
  const now = o.now ?? Date.now;
  const maxAge = o.maxAgeMs ?? 30_000;
  if (!OPS_DEPLOYMENT_RE.test(o.deployment)) throw new Error("部署标识不合规");
  const signerPrints = [...o.keys.values()].map((k) => (publicPemOf(k) ? opsKeyFingerprint(publicPemOf(k)!) : "not_public")).sort();
  let seen: { version: number; digest: string; signer_fps?: string[] } | null = null;
  let seenCorrupt = false;
  if (o.seenFile) {
    try {
      const s = JSON.parse(readFileSync(o.seenFile, "utf8")) as { version?: unknown; digest?: unknown; signer_fps?: unknown };
      if (!Number.isSafeInteger(s.version) || typeof s.digest !== "string" || !/^[0-9a-f]{64}$/.test(s.digest)) throw new Error("格式不符");
      seen = { version: s.version as number, digest: s.digest, ...(Array.isArray(s.signer_fps) ? { signer_fps: s.signer_fps.map(String) } : {}) };
    } catch (e) {
      // 没有记录 = 首次部署；有记录却读不出 = 运营接口整组不可用（不能悄悄丢掉回滚保护），业务照常
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") seenCorrupt = true;
    }
  }
  const history = (rec: Record<string, unknown>) => {
    if (o.historyFile) appendSynced(o.historyFile, `${JSON.stringify({ at: new Date(now()).toISOString(), ...rec })}\n`);
  };
  // 名册签名公钥换了（轮换或被替换）：留一条记录（换锚不再无痕；复核 RA10A-08）
  if (seen?.signer_fps && seen.signer_fps.join(",") !== signerPrints.join(",")) {
    try {
      history({ event: "roster_keys_changed", from: seen.signer_fps, to: signerPrints });
    } catch {
      // 记不下来：接受新名册时会再写，写不进去即不认
    }
  }
  let cache: { stamp: string; at: number; state: OpsRosterState } | null = null;
  const load = (): { state: OpsRosterState; cacheable: boolean } => {
    if (seenCorrupt) return { state: { ok: false, reason: "roster_seen_corrupt" }, cacheable: false };
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(o.file, "utf8"));
    } catch {
      return { state: { ok: false, reason: "roster_unavailable" }, cacheable: false };
    }
    const v = verifyOpsRoster(doc, o.keys);
    if (!v.ok) return { state: v, cacheable: true };
    const b = v.body;
    if (b.deployment !== o.deployment) return { state: { ok: false, reason: "roster_deployment_mismatch" }, cacheable: true };
    for (const op of b.operators) for (const k of op.keys) if (signerPrints.includes(opsKeyFingerprint(k.public_key_pem))) return { state: { ok: false, reason: "roster_signer_is_operator" }, cacheable: true };
    if (Date.parse(b.issued_at) > now() + OPS_REQUEST_MAX_SKEW_MS) return { state: { ok: false, reason: "roster_not_yet_valid" }, cacheable: false };
    if (o.minVersion !== undefined && b.version < o.minVersion) return { state: { ok: false, reason: "roster_rollback" }, cacheable: true };
    if (seen && b.version < seen.version) return { state: { ok: false, reason: "roster_rollback" }, cacheable: true };
    if (seen && b.version === seen.version && v.digest !== seen.digest) return { state: { ok: false, reason: "roster_conflict" }, cacheable: true };
    if (seen && b.version > seen.version + OPS_ROSTER_MAX_VERSION_JUMP) return { state: { ok: false, reason: "roster_version_jump" }, cacheable: true };
    const fresh = !seen || b.version > seen.version || (seen.signer_fps ?? []).join(",") !== signerPrints.join(",");
    if (fresh && (o.seenFile || o.historyFile)) {
      try {
        if (!seen || b.version > seen.version) history({ event: "roster_accepted", version: b.version, digest: v.digest.slice(0, 16), signer: (doc as SignedOpsRoster).kid, operators: b.operators.length, active: b.operators.filter((x) => x.status === "active").length, expires_at: b.expires_at });
        if (o.seenFile) writeAtomic(o.seenFile, JSON.stringify({ version: b.version, digest: v.digest, signer_fps: signerPrints }));
      } catch {
        return { state: { ok: false, reason: "roster_seen_unwritable" }, cacheable: false };
      }
    }
    if (fresh) seen = { version: b.version, digest: v.digest, signer_fps: signerPrints };
    return { state: v, cacheable: true };
  };
  return {
    current() {
      let stamp: string;
      try {
        const st = statSync(o.file);
        stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
      } catch {
        cache = null;
        return { ok: false, reason: seenCorrupt ? "roster_seen_corrupt" : "roster_unavailable" };
      }
      if (!cache || cache.stamp !== stamp || now() - cache.at >= maxAge) {
        const r = load();
        cache = r.cacheable ? { stamp, at: now(), state: r.state } : null;
        if (!r.state.ok || Date.parse(r.state.body.expires_at) > now()) return r.state;
        return { ok: false, reason: "roster_expired" };
      }
      // 有效期每次都看（缓存里的名册也会到期）
      if (cache.state.ok && Date.parse(cache.state.body.expires_at) <= now()) return { ok: false, reason: "roster_expired" };
      return cache.state;
    },
  };
}

/** 防重放：随机数用过返回 true，否则记下并返回 false；记不下来即抛错（运营请求按失败处理）。 */
export interface OpsNonceStore {
  seen(key: string, now: number): boolean;
}

/** 随机数保留到“首次见到 + 两倍时刻窗口 + 1 毫秒”：时刻窗口的最后一毫秒也不能重放（复核 RA10B-17）。 */
const nonceExpiry = (now: number) => now + 2 * OPS_REQUEST_MAX_SKEW_MS + 1;

export function memoryNonceStore(): OpsNonceStore {
  const m = new Map<string, number>();
  return {
    seen(key, now) {
      if (m.size > 10_000) for (const [k, e] of m) if (e <= now) m.delete(k);
      const e = m.get(key);
      if (e !== undefined && e > now) return true;
      m.set(key, nonceExpiry(now));
      return false;
    },
  };
}

/**
 * 落盘的随机数记录（JSON Lines，每条 fsync 后才放行）：服务重启后，时间窗内截获的运营请求仍不能重放
 * （中继按事项重置、按租户删除都是破坏性操作）。只存随机数键的摘要与到期时刻；过期的在记录变多时整理掉。
 */
export function fileNonceStore(file: string): OpsNonceStore {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const m = new Map<string, number>();
  let lines = 0;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as { k?: unknown; e?: unknown };
        if (typeof r.k === "string" && typeof r.e === "number") m.set(r.k, r.e);
        lines += 1;
      } catch {
        // 末尾半行（写到一半断电）：跳过
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }
  const h = (key: string) => sha256(key).toString("base64url").slice(0, 32);
  return {
    seen(key, now) {
      const k = h(key);
      const e = m.get(k);
      if (e !== undefined && e > now) return true;
      const exp = nonceExpiry(now);
      appendSynced(file, `${JSON.stringify({ k, e: exp })}\n`);
      m.set(k, exp);
      lines += 1;
      if (lines > 1000) {
        for (const [x, xe] of m) if (xe <= now) m.delete(x);
        if (m.size * 2 < lines) {
          writeAtomic(file, [...m].map(([x, xe]) => `${JSON.stringify({ k: x, e: xe })}\n`).join(""));
          lines = m.size;
        }
      }
      return false;
    },
  };
}

export type OpsRequestHeaders = {
  "x-kwl-op": string;
  "x-kwl-op-key": string;
  "x-kwl-op-ts": string;
  "x-kwl-op-nonce": string;
  "x-kwl-op-sig": string;
};

export interface OpsRequestParts {
  method: string;
  /** 请求行里的路径（原样，含查询串）。 */
  path: string;
  body?: string | Uint8Array;
}

function requestBytes(p: OpsRequestParts & { deployment: string; audience: string; operator: string; kid: string; ts: string; nonce: string }): Buffer {
  const body = p.body === undefined ? "" : p.body;
  return Buffer.from(
    REQ_DOMAIN +
      canonicalJson({
        a: `${p.deployment}/${p.audience}`,
        m: p.method.toUpperCase(),
        p: p.path,
        b: sha256(typeof body === "string" ? Buffer.from(body, "utf8") : body).toString("base64url"),
        o: p.operator,
        k: p.kid,
        ts: p.ts,
        n: p.nonce,
      }),
    "utf8",
  );
}

/** 运营人员签请求（运营命令行与测试用）：私钥只在本人电脑（或带口令加密的私钥文件）里。 */
export function signOpsRequest(p: OpsRequestParts & { deployment: string; audience: OpsAudience; operator: string; kid: string; privateKey: OpsSigningKey; now?: number }): OpsRequestHeaders {
  const ts = String(p.now ?? Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const sig = signWith(p.privateKey, requestBytes({ ...p, ts, nonce }));
  return { "x-kwl-op": p.operator, "x-kwl-op-key": p.kid, "x-kwl-op-ts": ts, "x-kwl-op-nonce": nonce, "x-kwl-op-sig": sig };
}

export class OpsAuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/**
 * 被拒的运营请求（服务写进内部记录 ops/rejects.jsonl）。
 * - verified：签名核验通过之后才被拒（重放、双因素、越权）——claimed 就是真实的运营编号，这类一律记、不占额度；
 * - 未核验的（缺头、过期、签名不符、未登记或已吊销、名册不可用）claimed 只是请求自称，**未经核验**，每分钟至多 N 条，
 *   超出的在下一分钟开头补记一条 ops_rejects_dropped（dropped = 条数）。
 */
export interface OpsRejectRecord {
  at: string;
  audience: OpsAudience;
  claimed: string | null;
  verified: boolean;
  reason: string;
  /** 名册不可用的具体原因（roster_rollback、roster_expired 等）。 */
  roster_reason?: string;
  roster_version?: number;
  method: string;
  path: string;
  dropped?: number;
}

export interface OpsAuthorized {
  operator: string;
  kid: string;
  roster_version: number;
  /** 此人的全部权限（路由按请求内容另需的权限据此判断，例如开通时附带点数须 quota.manage）。 */
  perms: OpsPermission[];
}

export interface OpsGuard {
  readonly audience: OpsAudience;
  /**
   * 核验运营请求并检查权限（给数组即须全有）：通过返回运营编号、密钥编号、名册版本与此人的全部权限；不通过抛 OpsAuthError——
   * 对外的原因代码不区分“未登记、已吊销、签名不符”（都是 ops_auth_invalid，免得被用来枚举名册），细分原因只进被拒记录。
   */
  authorize(headers: Readonly<Record<string, string | string[] | undefined>>, req: OpsRequestParts, permission: OpsPermission | readonly OpsPermission[]): OpsAuthorized;
}

export function createOpsGuard(o: {
  audience: OpsAudience;
  roster: OpsRosterSource;
  nonces: OpsNonceStore;
  now?: () => number;
  /** 双因素核验器（接口占位，D-106）：名册里 second_factor 不是 "none" 的人须经它核验。 */
  secondFactor?: (op: OpsOperator, headers: Readonly<Record<string, string | string[] | undefined>>) => boolean;
  onReject?: (r: OpsRejectRecord) => void;
  /** 未核验的被拒记录每分钟至多几条（缺省 60）。 */
  rejectLogPerMinute?: number;
}): OpsGuard {
  if (!(OPS_AUDIENCES as readonly string[]).includes(o.audience)) throw new Error("运营受众不合规");
  const now = o.now ?? Date.now;
  const cap = o.rejectLogPerMinute ?? 60;
  let win = { minute: -1, n: 0, dropped: 0 };
  const log = (r: Omit<OpsRejectRecord, "at" | "audience">) => {
    if (!o.onReject) return;
    try {
      o.onReject({ at: new Date(now()).toISOString(), audience: o.audience, ...r });
    } catch {
      // 记录写不进去：请求本来就被拒
    }
  };
  const reject = (status: number, external: string, detail: string, claimed: string | null, verified: boolean, req: OpsRequestParts, extra: { roster_reason?: string; roster_version?: number } = {}): never => {
    const minute = Math.floor(now() / 60_000);
    if (win.minute !== minute) {
      if (win.dropped > 0) log({ claimed: null, verified: false, reason: "ops_rejects_dropped", method: "", path: "", dropped: win.dropped });
      win = { minute, n: 0, dropped: 0 };
    }
    const rec = { claimed, verified, reason: detail, ...extra, method: String(req.method).toUpperCase().slice(0, 10), path: String(req.path).split("?")[0]!.slice(0, 200) };
    if (verified) log(rec);
    else if (++win.n <= cap) log(rec);
    else win.dropped += 1;
    throw new OpsAuthError(status, external);
  };
  return {
    audience: o.audience,
    authorize(headers, req, permission) {
      const h = (k: keyof OpsRequestHeaders): string | null => {
        const v = headers[k];
        return typeof v === "string" && v.length > 0 && v.length < 512 ? v : null;
      };
      const op = h("x-kwl-op");
      const kid = h("x-kwl-op-key");
      const ts = h("x-kwl-op-ts");
      const nonce = h("x-kwl-op-nonce");
      const sig = h("x-kwl-op-sig");
      const claimed = op && OPERATOR_ID_RE.test(op) ? op : null;
      if (!claimed || !kid || !OPS_KEY_ID_RE.test(kid) || !ts || !/^\d{1,15}$/.test(ts) || !nonce || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !sig) return reject(401, "ops_auth_missing", "ops_auth_missing", claimed, false, req);
      if (Math.abs(now() - Number(ts)) > OPS_REQUEST_MAX_SKEW_MS) return reject(401, "ops_auth_stale", "ops_auth_stale", claimed, false, req);
      const roster = o.roster.current();
      if (!roster.ok) return reject(503, "ops_roster_unavailable", "ops_roster_unavailable", claimed, false, req, { roster_reason: roster.reason });
      const rv = { roster_version: roster.body.version };
      const person = roster.body.operators.find((x) => x.id === claimed);
      const key = person?.status === "active" ? person.keys.find((k) => k.kid === kid) : undefined;
      if (!person || !key) return reject(401, "ops_auth_invalid", "ops_operator_unknown_or_revoked", claimed, false, req, rv);
      if (!verifyBytes(key.public_key_pem, requestBytes({ ...req, deployment: roster.body.deployment, audience: o.audience, operator: claimed, kid, ts, nonce }), sig)) return reject(401, "ops_auth_invalid", "ops_auth_signature_invalid", claimed, false, req, rv);
      if (person.second_factor !== "none") {
        if (!o.secondFactor) return reject(401, "ops_auth_invalid", "ops_second_factor_unavailable", claimed, true, req, rv);
        if (!o.secondFactor(person, headers)) return reject(401, "ops_auth_invalid", "ops_second_factor_failed", claimed, true, req, rv);
      }
      let replayed: boolean;
      try {
        replayed = o.nonces.seen(`${claimed}\u0000${nonce}`, now());
      } catch {
        return reject(503, "ops_nonce_store_unavailable", "ops_nonce_store_unavailable", claimed, true, req, rv);
      }
      if (replayed) return reject(401, "ops_auth_replayed", "ops_auth_replayed", claimed, true, req, rv);
      const need: readonly OpsPermission[] = typeof permission === "string" ? [permission] : permission;
      if (!need.every((p) => person.perms.includes(p))) return reject(403, "ops_permission_denied", "ops_permission_denied", claimed, true, req, rv);
      return { operator: claimed, kid, roster_version: roster.body.version, perms: [...person.perms] };
    },
  };
}

/** 生成一对运营签名密钥（Ed25519）；给了口令即按 PKCS#8 + AES-256 加密私钥（运营命令行 keygen 与测试用）。 */
export function generateOpsKeyPair(passphrase?: string): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export(passphrase ? { format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase } : { format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

/** 文件追加并 fsync（控制面运营访问审计“先记已请求”用：记不下来即不执行）。 */
export const appendLineSynced = (path: string, rec: unknown) => appendSynced(path, `${JSON.stringify(rec)}\n`);
