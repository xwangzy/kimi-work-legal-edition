/**
 * 运营按人鉴权（v9.3 A-10；调研 Y2 §3.12“运营控制台：堡垒机 + 双因素 + 三权分立”、§1.3 等保“两种以上鉴别技术、其一为密码技术”）。
 *
 * 取代各云端服务的共享运营口令（opsSecret + 自报的操作人头，D-80）：
 * - **运营名册**（安全管理员签名）：每位运营人员一个运营编号（工号形态 `op_…`，不用姓名）、一把或几把签名公钥（Ed25519 或 P-256——
 *   P-256 可放进 USBKey / 智能卡）、权限清单与状态。吊销某人 = 签发新版本名册把他标为 revoked；丢了一把密钥 = 只删掉那一把。
 *   名册版本只增：服务记下见过的最高版本与摘要，旧版本（被吊销者仍有效的那一版）或同版本不同内容一律不认，运营接口失败关闭。
 *   名册签名私钥由安全管理员离线保管、不在任何服务上；运营人员改不了自己的权限（三权分立的研发侧）。
 * - **运营请求签名**：每个请求用本人私钥签“服务 + 方法 + 路径 + 请求体摘要 + 运营编号 + 密钥编号 + 时刻 + 随机数”；
 *   服务按名册核验（时刻偏差 ≤ 5 分钟、随机数落盘不重放、权限按接口），访问审计记到运营编号与密钥编号。云端只存公钥。
 * - **双因素**：只留接口——名册里每人的 second_factor 目前只认 "none"；标了别的而服务没有接上核验器即拒绝（失败关闭）。
 *   堡垒机、会话录像与真实双因素依赖云选型（D-106）。
 * 本包不含联网代码；云端服务（控制面、支持、中继、通知）、生产入口与运营命令行（scripts/ops-cli.mjs）共用。
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, signAlgOfPublicKey, signWithKey, verifyBytes } from "@zr-legal/keys";

/** 权限：按接口授予（控制面开通与计费、发码、加量与上限、吊销；支持查看与删除；中继按事项重置；按租户整体删除）。 */
export const OPS_PERMISSIONS = ["tenant.read", "tenant.manage", "activation.issue", "quota.manage", "device.revoke", "support.read", "support.delete", "relay.reset", "tenant.purge"] as const;
export type OpsPermission = (typeof OPS_PERMISSIONS)[number];
/** 受众：签名绑定到哪一个服务（同一请求不能拿到另一个服务去用）。 */
export const OPS_AUDIENCES = ["control-plane", "support", "relay", "notify"] as const;
export type OpsAudience = (typeof OPS_AUDIENCES)[number];
/** 运营编号：工号形态，不用姓名（会进律所可见的运营审计流水，流水不可删）。 */
export const OPERATOR_ID_RE = /^op_[a-z0-9][a-z0-9-]{1,31}$/;
export const OPS_KEY_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const OPS_REQUEST_MAX_SKEW_MS = 5 * 60_000;
export const OPS_ROSTER_FORMAT = "kwl-ops-roster/1";
/**
 * 运营路径：/v1/ops/…（控制面）与 /v1/<服务>/ops/…（支持、中继、通知）——生产入口按来源网段收紧用。
 * 服务逐个列出（不用通配，免得把业务路径里恰好叫 ops 的编号当成运营路径）；服务源码里出现新的运营路径而这里没列，门禁失败（ops-auth.test.ts）。
 */
export const OPS_PATH_RE = /^\/v1\/(?:(?:support|relay|notify)\/)?ops(?:\/|$)/;
const ROSTER_DOMAIN = "kwl-ops-roster-v1\n";
const REQ_DOMAIN = "kwl-ops-request-v1\n";
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
  version: number;
  issued_at: string;
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

/** 公钥指纹（SPKI DER 的 SHA-256 前 16 位 base64url）：安全管理员登记时与本人当面或电话核对。 */
export function opsKeyFingerprint(publicKeyPem: string): string {
  return sha256(createPublicKey(publicKeyPem).export({ format: "der", type: "spki" })).toString("base64url").slice(0, 16);
}

/** 名册内容逐项校验：不合规返回原因代码。 */
export function validateOpsRosterBody(x: unknown): string | null {
  const b = x as OpsRosterBody;
  if (!b || typeof b !== "object" || Array.isArray(b)) return "roster_malformed";
  if (keysOf(b) !== "format,issued_at,operators,version") return "roster_malformed";
  if (b.format !== OPS_ROSTER_FORMAT) return "roster_format_unknown";
  if (!Number.isSafeInteger(b.version) || b.version < 1 || b.version > 1e9 || !isoOk(b.issued_at)) return "roster_malformed";
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
    if (!Array.isArray(op.keys) || op.keys.length > MAX_KEYS) return "roster_keys_invalid";
    const kids = new Set<string>();
    for (const key of op.keys) {
      if (!key || typeof key !== "object" || keysOf(key) !== "added_at,kid,public_key_pem") return "roster_keys_invalid";
      if (typeof key.kid !== "string" || !OPS_KEY_ID_RE.test(key.kid) || kids.has(key.kid)) return "roster_keys_invalid";
      kids.add(key.kid);
      if (typeof key.public_key_pem !== "string" || key.public_key_pem.length > 2000 || !signAlgOfPublicKey(key.public_key_pem) || !isoOk(key.added_at)) return "roster_keys_invalid";
      // 同一把公钥不能登记给两个人（否则一人的密钥能以两个运营编号行事）
      const fp = opsKeyFingerprint(key.public_key_pem);
      if (prints.has(fp)) return "roster_key_shared";
      prints.add(fp);
    }
  }
  return null;
}

const rosterBytes = (body: OpsRosterBody) => Buffer.from(ROSTER_DOMAIN + canonicalJson(body), "utf8");
const pemOf = (k: string | KeyObject) => (typeof k === "string" ? k : k.export({ format: "pem", type: "spki" }).toString());

/** 安全管理员签发名册（运营命令行与测试用）；内容不合规即抛错。 */
export function signOpsRoster(body: OpsRosterBody, signer: { kid: string; privateKey: string | KeyObject }): SignedOpsRoster {
  const why = validateOpsRosterBody(body);
  if (why) throw new Error(`运营名册不合规：${why}`);
  if (!OPS_KEY_ID_RE.test(signer.kid)) throw new Error("名册签名密钥编号不合规");
  return { body, kid: signer.kid, sig: signWithKey(signer.privateKey, rosterBytes(body)) };
}

export type OpsRosterVerdict = { ok: true; body: OpsRosterBody; digest: string } | { ok: false; reason: string };

/** 核验名册：结构、签名密钥在册、签名有效、内容合规；digest 为待签字节的 SHA-256（十六进制）。 */
export function verifyOpsRoster(doc: unknown, keys: ReadonlyMap<string, string | KeyObject>): OpsRosterVerdict {
  const d = doc as SignedOpsRoster;
  if (!d || typeof d !== "object" || Array.isArray(d) || keysOf(d) !== "body,kid,sig") return { ok: false, reason: "roster_malformed" };
  const why = validateOpsRosterBody(d.body);
  if (why) return { ok: false, reason: why };
  const key = typeof d.kid === "string" ? keys.get(d.kid) : undefined;
  if (!key) return { ok: false, reason: "roster_signer_unknown" };
  const bytes = rosterBytes(d.body);
  if (!verifyBytes(pemOf(key), bytes, String(d.sig))) return { ok: false, reason: "roster_signature_invalid" };
  return { ok: true, body: d.body, digest: sha256(bytes).toString("hex") };
}

export type OpsRosterState = { ok: true; body: OpsRosterBody; digest: string } | { ok: false; reason: string };
export interface OpsRosterSource {
  current(): OpsRosterState;
}

/** 原子写（临时文件 + fsync + 改名）。 */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * 名册来源：从文件读（生产由部署挂载为只读文件，安全管理员换新版本即生效），文件有变化或距上次核验满 30 秒即重新核验；
 * 每次运营请求都经这里取当前名册，吊销不需要重启服务。
 * seenFile：记下见过的最高版本与摘要（回滚保护）——写不进去时不认新名册（否则回滚保护静默失效）。
 */
export function fileRosterSource(o: { file: string; keys: ReadonlyMap<string, string | KeyObject>; seenFile?: string; now?: () => number; maxAgeMs?: number }): OpsRosterSource {
  const now = o.now ?? Date.now;
  const maxAge = o.maxAgeMs ?? 30_000;
  let seen: { version: number; digest: string } | null = null;
  if (o.seenFile) {
    try {
      const s = JSON.parse(readFileSync(o.seenFile, "utf8")) as { version?: unknown; digest?: unknown };
      if (Number.isSafeInteger(s.version) && typeof s.digest === "string" && /^[0-9a-f]{64}$/.test(s.digest)) seen = { version: s.version as number, digest: s.digest };
      else throw new Error("名册版本记录格式不符");
    } catch (e) {
      // 没有记录 = 首次部署；有记录却读不出 = 拒绝启动（不能悄悄丢掉回滚保护）
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw new Error(`运营名册版本记录读不出：${o.seenFile}`);
    }
  }
  let cache: { stamp: string; at: number; state: OpsRosterState } | null = null;
  const load = (): { state: OpsRosterState; cacheable: boolean } => {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(o.file, "utf8"));
    } catch {
      return { state: { ok: false, reason: "roster_unavailable" }, cacheable: false };
    }
    const v = verifyOpsRoster(doc, o.keys);
    if (!v.ok) return { state: v, cacheable: true };
    if (seen && v.body.version < seen.version) return { state: { ok: false, reason: "roster_rollback" }, cacheable: true };
    if (seen && v.body.version === seen.version && v.digest !== seen.digest) return { state: { ok: false, reason: "roster_conflict" }, cacheable: true };
    if (o.seenFile && (!seen || v.body.version > seen.version)) {
      try {
        writeAtomic(o.seenFile, JSON.stringify({ version: v.body.version, digest: v.digest }));
      } catch {
        return { state: { ok: false, reason: "roster_seen_unwritable" }, cacheable: false };
      }
    }
    if (!seen || v.body.version > seen.version) seen = { version: v.body.version, digest: v.digest };
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
        return { ok: false, reason: "roster_unavailable" };
      }
      if (cache && cache.stamp === stamp && now() - cache.at < maxAge) return cache.state;
      const r = load();
      cache = r.cacheable ? { stamp, at: now(), state: r.state } : null;
      return r.state;
    },
  };
}

/** 防重放：随机数用过返回 true，否则记下并返回 false；记不下来即抛错（运营请求按失败处理）。 */
export interface OpsNonceStore {
  seen(key: string, now: number): boolean;
}

export function memoryNonceStore(): OpsNonceStore {
  const m = new Map<string, number>();
  return {
    seen(key, now) {
      if (m.size > 10_000) for (const [k, e] of m) if (e <= now) m.delete(k);
      const e = m.get(key);
      if (e !== undefined && e > now) return true;
      m.set(key, now + 2 * OPS_REQUEST_MAX_SKEW_MS);
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
      const exp = now + 2 * OPS_REQUEST_MAX_SKEW_MS;
      const fd = openSync(file, "a", 0o600);
      try {
        writeSync(fd, `${JSON.stringify({ k, e: exp })}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
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

function requestBytes(p: OpsRequestParts & { audience: string; operator: string; kid: string; ts: string; nonce: string }): Buffer {
  const body = p.body === undefined ? "" : p.body;
  return Buffer.from(
    REQ_DOMAIN +
      canonicalJson({
        a: p.audience,
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

/** 运营人员签请求（运营命令行与测试用）：私钥只在本人电脑或硬件令牌里。 */
export function signOpsRequest(p: OpsRequestParts & { audience: OpsAudience; operator: string; kid: string; privateKey: string | KeyObject; now?: number }): OpsRequestHeaders {
  const ts = String(p.now ?? Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const sig = signWithKey(p.privateKey, requestBytes({ ...p, ts, nonce }));
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

/** 被拒的运营请求（服务写进内部访问审计；按分钟限量）：只有声称的运营编号（格式合规才记）、原因与路径。 */
export interface OpsRejectRecord {
  at: string;
  audience: OpsAudience;
  /** 请求声称的运营编号（未经核验）；格式不合规为 null。 */
  claimed: string | null;
  reason: string;
  method: string;
  path: string;
}

export interface OpsGuard {
  readonly audience: OpsAudience;
  /** 核验运营请求并检查权限：通过返回运营编号与密钥编号；不通过抛 OpsAuthError（401 / 403 / 503）。 */
  authorize(headers: Readonly<Record<string, string | string[] | undefined>>, req: OpsRequestParts, permission: OpsPermission): { operator: string; kid: string };
}

export function createOpsGuard(o: {
  audience: OpsAudience;
  roster: OpsRosterSource;
  nonces: OpsNonceStore;
  now?: () => number;
  /** 双因素核验器（接口占位，D-106）：名册里 second_factor 不是 "none" 的人须经它核验。 */
  secondFactor?: (op: OpsOperator, headers: Readonly<Record<string, string | string[] | undefined>>) => boolean;
  onReject?: (r: OpsRejectRecord) => void;
  /** 被拒记录每分钟至多几条（缺省 60；防止乱发请求撑大审计）。 */
  rejectLogPerMinute?: number;
}): OpsGuard {
  if (!(OPS_AUDIENCES as readonly string[]).includes(o.audience)) throw new Error("运营受众不合规");
  const now = o.now ?? Date.now;
  const cap = o.rejectLogPerMinute ?? 60;
  let win = { minute: -1, n: 0 };
  const reject = (status: number, code: string, claimed: string | null, req: OpsRequestParts): never => {
    if (o.onReject) {
      const minute = Math.floor(now() / 60_000);
      if (win.minute !== minute) win = { minute, n: 0 };
      win.n += 1;
      if (win.n <= cap) {
        try {
          o.onReject({ at: new Date(now()).toISOString(), audience: o.audience, claimed, reason: code, method: String(req.method).toUpperCase().slice(0, 10), path: String(req.path).split("?")[0]!.slice(0, 200) });
        } catch {
          // 审计写不进去：请求本来就被拒
        }
      }
    }
    throw new OpsAuthError(status, code);
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
      if (!claimed || !kid || !OPS_KEY_ID_RE.test(kid) || !ts || !/^\d{1,15}$/.test(ts) || !nonce || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !sig) return reject(401, "ops_auth_missing", claimed, req);
      if (Math.abs(now() - Number(ts)) > OPS_REQUEST_MAX_SKEW_MS) return reject(401, "ops_auth_stale", claimed, req);
      const roster = o.roster.current();
      if (!roster.ok) return reject(503, "ops_roster_unavailable", claimed, req);
      const person = roster.body.operators.find((x) => x.id === claimed);
      const key = person?.status === "active" ? person.keys.find((k) => k.kid === kid) : undefined;
      if (!person || !key) return reject(401, "ops_operator_unknown_or_revoked", claimed, req);
      if (!verifyBytes(key.public_key_pem, requestBytes({ ...req, audience: o.audience, operator: claimed, kid, ts, nonce }), sig)) return reject(401, "ops_auth_signature_invalid", claimed, req);
      if (person.second_factor !== "none") {
        if (!o.secondFactor) return reject(401, "ops_second_factor_unavailable", claimed, req);
        if (!o.secondFactor(person, headers)) return reject(401, "ops_second_factor_failed", claimed, req);
      }
      let replayed: boolean;
      try {
        replayed = o.nonces.seen(`${claimed}\u0000${nonce}`, now());
      } catch {
        return reject(503, "ops_nonce_store_unavailable", claimed, req);
      }
      if (replayed) return reject(401, "ops_auth_replayed", claimed, req);
      if (!person.perms.includes(permission)) return reject(403, "ops_permission_denied", claimed, req);
      return { operator: claimed, kid };
    },
  };
}

/** 生成一对运营签名密钥（Ed25519；运营命令行 keygen 与测试用）。 */
export function generateOpsKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString() };
}

/**
 * 仅测试与开发：一份签好的名册（每人一把 Ed25519 密钥，密钥编号 k1）、名册签名公钥表，以及按人签请求的函数。
 */
export function devOpsRoster(operators: { id: string; perms: OpsPermission[]; status?: OpsOperator["status"]; second_factor?: string }[], version = 1) {
  const signerKey = generateOpsKeyPair();
  const signer = { kid: "sec-dev", privateKey: signerKey.privateKeyPem };
  const at = new Date().toISOString();
  const personal = new Map(operators.map((x) => [x.id, generateOpsKeyPair()]));
  const body = (v: number, ops = operators): OpsRosterBody => ({
    format: OPS_ROSTER_FORMAT,
    version: v,
    issued_at: at,
    operators: ops.map((x) => ({
      id: x.id,
      status: x.status ?? "active",
      perms: [...x.perms],
      keys: [{ kid: "k1", public_key_pem: personal.get(x.id)?.publicKeyPem ?? generateOpsKeyPair().publicKeyPem, added_at: at }],
      second_factor: x.second_factor ?? "none",
      ...(x.status === "revoked" ? { revoked_at: at } : {}),
    })),
  });
  return {
    roster: signOpsRoster(body(version), signer),
    rosterKeys: new Map([[signer.kid, signerKey.publicKeyPem]]) as ReadonlyMap<string, string>,
    rosterSigner: signer,
    /** 用同一名册签名密钥重签一份（版本与人员可改；用于吊销与回滚用例）。 */
    resign: (v: number, ops = operators) => signOpsRoster(body(v, ops), signer),
    keyOf: (id: string) => ({ kid: "k1", privateKeyPem: personal.get(id)!.privateKeyPem, publicKeyPem: personal.get(id)!.publicKeyPem }),
    sign: (id: string, audience: OpsAudience, req: OpsRequestParts, now?: number) =>
      signOpsRequest({ ...req, audience, operator: id, kid: "k1", privateKey: personal.get(id)!.privateKeyPem, ...(now !== undefined ? { now } : {}) }),
  };
}

/** 仅测试与开发：把名册写进文件并返回守卫（随机数落盘在同一目录）。 */
export function fileOpsGuard(o: { dir: string; audience: OpsAudience; roster: SignedOpsRoster; rosterKeys: ReadonlyMap<string, string | KeyObject>; now?: () => number; onReject?: (r: OpsRejectRecord) => void }): OpsGuard {
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  writeFileSync(`${o.dir}/roster.json`, JSON.stringify(o.roster), { mode: 0o600 });
  return createOpsGuard({
    audience: o.audience,
    roster: fileRosterSource({ file: `${o.dir}/roster.json`, keys: o.rosterKeys, seenFile: `${o.dir}/roster-seen.json`, ...(o.now ? { now: o.now } : {}) }),
    nonces: fileNonceStore(`${o.dir}/nonces.jsonl`),
    ...(o.now ? { now: o.now } : {}),
    ...(o.onReject ? { onReject: o.onReject } : {}),
  });
}
