/**
 * 开通与成员入组（v9.3 第 13 批；设计 docs/design/开通与成员入组设计-v1.md）的共用格式：控制面与律所侧各自独立计算，不含联网代码。
 *
 * - 开通码 / 邀请码：20 位 Crockford Base32（100 bit 随机），按 4 位一组、连字符分隔显示；输入时忽略大小写、空格与连字符，
 *   I/L 读作 1、O 读作 0（Crockford 约定，律师照着微信念出来也不会错）。云端只存 HMAC 摘要。
 * - 入组核对码：成员机与管理员机各自由（租户、设备编号、两把公钥）算出 12 位十进制数字，当面或电话念一遍一致才批准——
 *   防止控制面把申请里的公钥换成别人的。律所核对码同理（律所根公钥指纹），成员取回证书后可与管理员核对。
 * - 入组证明：成员设备用自己的签名私钥签申请字节，证明持有私钥（控制面与管理员都核）。
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@zr-legal/keys";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ACTIVATION_CODE_LEN = 20;

/** 生成一个开通码（规范形，无分隔符）。 */
export function newActivationCode(): string {
  const bytes = randomBytes(ACTIVATION_CODE_LEN);
  let s = "";
  for (const b of bytes) s += CROCKFORD[b & 31];
  return s;
}

/** 输入归一：去空白与连字符、大写、I/L→1、O→0；不是 20 位合法字符即 null。 */
export function normalizeActivationCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const s = input
    .toUpperCase()
    .replace(/[\s\-‐-―－]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (s.length !== ACTIVATION_CODE_LEN) return null;
  for (const c of s) if (!CROCKFORD.includes(c)) return null;
  return s;
}

/**
 * 邀请码的本机秘密段（第 13 批复核 A-01/02/03）：管理员本机生成 16 位 Crockford（80 bit），**不经控制面**，附在控制面的 20 位码后面，
 * 一起经微信或当面交给同事（显示为 36 位、9 组）。成员机用它对入组申请做 HMAC，管理员机用它核对申请、并对批准结果做 HMAC——
 * 控制面不知道这段秘密：改不了申请里的公钥与成员，伪造不了律所根与证书，也无从离线碾磨。创始开通码（运营发）没有这一段。
 */
export const INVITE_SECRET_LEN = 16;

export function newInviteSecret(): string {
  const bytes = randomBytes(INVITE_SECRET_LEN);
  let s = "";
  for (const b of bytes) s += CROCKFORD[b & 31];
  return s;
}

/** 输入归一后拆成控制面码与本机秘密段：20 位（开通码）或 36 位（邀请码）；其余长度为 null。 */
export function splitInvitationInput(input: unknown): { code: string; secret: string | null } | null {
  if (typeof input !== "string" || input.length > 96) return null;
  const s = input
    .toUpperCase()
    .replace(/[\s\-‐-―－]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  for (const c of s) if (!CROCKFORD.includes(c)) return null;
  if (s.length === ACTIVATION_CODE_LEN) return { code: s, secret: null };
  if (s.length === ACTIVATION_CODE_LEN + INVITE_SECRET_LEN) return { code: s.slice(0, ACTIVATION_CODE_LEN), secret: s.slice(ACTIVATION_CODE_LEN) };
  return null;
}

const inviteKey = (secret: string) => Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("kwl"), Buffer.from("kwl-invite-mac/1"), 32));

/** 入组申请的待 MAC 字节（成员机算、管理员机核）：租户、码记录、设备编号、两把公钥、成员标识与角色。 */
export function joinMacBytes(o: { tid: string; activationId: string; deviceId: string; signPublicKeyPem: string; encPublicKeyPem: string; memberSlug: string; role: string }): Buffer {
  return Buffer.from(
    `kwl-join-mac/1\n${canonicalJson({ tid: o.tid, activation_id: o.activationId, device_id: o.deviceId, sign_pub: o.signPublicKeyPem, enc_pub: o.encPublicKeyPem, member_slug: o.memberSlug, role: o.role })}`,
    "utf8",
  );
}

/** 批准结果的待 MAC 字节（管理员机算、成员机核）：证书、律所根公钥与律所公钥包。 */
export function approvalMacBytes(o: { tid: string; joinRequestId: string; cert: unknown; rootPublicKeyPem: string; bundle: unknown }): Buffer {
  return Buffer.from(`kwl-approval-mac/1\n${canonicalJson({ tid: o.tid, join_request_id: o.joinRequestId, cert: o.cert, root_public_key_pem: o.rootPublicKeyPem, bundle: o.bundle })}`, "utf8");
}

export function inviteMac(secret: string, bytes: Uint8Array): string {
  return createHmac("sha256", inviteKey(secret)).update(bytes).digest("hex");
}

export function inviteMacValid(secret: string, bytes: Uint8Array, mac: unknown): boolean {
  if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const a = Buffer.from(inviteMac(secret, bytes), "hex");
  const b = Buffer.from(mac, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 入组设备编号只能是 dev_<律所标识>_<成员标识>（复核 A-02：控制面不能借设备编号碾磨核对码）。 */
export function expectedJoinDeviceId(firmSlug: string, memberSlug: string): string {
  return `dev_${firmSlug}_${memberSlug}`;
}

/** 显示形：4 位一组。 */
export function formatActivationCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

/** 云端存的摘要：HMAC-SHA256(胡椒, "kwl-activation/1\n" + 规范形)。 */
export function activationCodeMac(pepper: Uint8Array, code: string): string {
  return createHmac("sha256", pepper).update(`kwl-activation/1\n${code}`).digest("hex");
}

/** 认领凭据的摘要（云端只存摘要）。 */
export function claimSecretHash(secret: string): string {
  return createHash("sha256").update(`kwl-claim/1\n${secret}`).digest("hex");
}

export function newClaimSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** 12 位十进制数字，按 3 位一组显示（40 bit 截断：抵御在线替换足够；离线碰撞不在威胁模型内）。 */
function digitsOf(digest: Buffer): string {
  const n = digest.readUIntBE(0, 5); // 40 bit
  return String(n % 1_000_000_000_000).padStart(12, "0").replace(/(\d{3})(?=\d)/g, "$1 ");
}

/** 入组核对码：双方独立由租户、设备编号与两把公钥算出。 */
export function joinCheckCode(o: { tid: string; deviceId: string; signPublicKeyPem: string; encPublicKeyPem: string }): string {
  const h = createHash("sha256").update(`kwl-join/1\n${canonicalJson({ tid: o.tid, device_id: o.deviceId, sign_pub: o.signPublicKeyPem, enc_pub: o.encPublicKeyPem })}`).digest();
  return digitsOf(h);
}

/** 律所核对码（律所根公钥指纹）。 */
export function firmCheckCode(tid: string, rootPublicKeyPem: string): string {
  return digitsOf(createHash("sha256").update(`kwl-firm/1\n${canonicalJson({ tid, root_public_key_pem: rootPublicKeyPem })}`).digest());
}

/** 入组申请的待签字节（成员设备签名私钥签名，证明持有私钥）。 */
export function joinProofBytes(o: { tid: string; activationId: string; deviceId: string; signPublicKeyPem: string; encPublicKeyPem: string }): Buffer {
  return Buffer.from(
    `kwl-join-request/1\n${canonicalJson({ tid: o.tid, activation_id: o.activationId, device_id: o.deviceId, sign_pub: o.signPublicKeyPem, enc_pub: o.encPublicKeyPem })}`,
    "utf8",
  );
}

/**
 * 律所公钥包（管理员批准入组时随证书送达成员）：恢复托管公钥由律所根私钥签名——成员据此把事项密钥同时包裹给恢复托管
 * （与创始设备一致）；控制面只转交，换不了（签名用的是律所根）。
 */
export function firmBundleBytes(tid: string, rootPublicKeyPem: string, recoveryPublicKeyPem: string): Buffer {
  return Buffer.from(`kwl-firm-bundle/1\n${canonicalJson({ tid, root_public_key_pem: rootPublicKeyPem, recovery_public_key_pem: recoveryPublicKeyPem })}`, "utf8");
}

export interface FirmBundle {
  recovery_public_key_pem: string;
  /** 律所根私钥对 firmBundleBytes 的签名（base64）。 */
  sig: string;
}

/** 成员标识字符集（与内核 SLUG_PATTERN 一致：1–48 位，字母或数字开头）。 */
export const MEMBER_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
/** 成员显示名：1–40 个字符，不含控制字符。 */
export function validDisplayName(x: unknown): x is string {
  return typeof x === "string" && x.trim().length >= 1 && [...x].length <= 40 && !/[\p{Cc}\p{Cf}]/u.test(x);
}

/** 兑换开通码 / 邀请码的应答（控制面 → 客户端）。 */
export interface ActivationRedeemResult {
  ok: true;
  tid: string;
  activation_id: string;
  kind: "founder" | "member";
  firm: { slug: string; name: string };
  member: { slug: string; name: string | null; role: "admin" | "partner" | "lawyer" | "assistant" };
  claim_secret: string;
  edition: string;
}

/** 入组申请的状态（成员取回）。 */
export interface JoinFetchResult {
  ok: true;
  status: "pending" | "approved" | "rejected";
  cert?: unknown;
  root_public_key_pem?: string;
  firm_bundle?: FirmBundle;
}
