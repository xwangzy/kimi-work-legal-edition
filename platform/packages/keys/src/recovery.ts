/**
 * 恢复托管（方案 v5.0 第 4 篇 §5.3：每把事项密钥另包裹给律所恢复托管公钥；
 * 托管私钥离线生成，按 Shamir M-of-N 分持给多名合伙人，任何一人单独不可用；
 * 动用托管私钥是「破窗事件」——须 M 名持有人签名，写入审计链并通知事项成员）。
 * - 分持对象为托管私钥（X25519）PKCS8 内的 32 字节种子；privateKeyHash=sha256(种子) 供重组后校验，
 *   份额不足或有误时 hash 不符，返回 ok:false，绝不静默返回错误密钥。
 * - createBreakGlassRecord 只构造纯数据记录（落库、签名收集与通知由内核阶段做）。
 * 边界：托管私钥的离线保管、持有人身份与破窗审批流程不在本模块。
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { canonicalJson } from "./encoding.ts";
import { KeysError } from "./errors.ts";
import { x25519PrivateKeyPemFromSeed, x25519PrivateSeed } from "./matter-keys.ts";
import { combineShares, splitSecret, type Share } from "./shamir.ts";
import { sha256B64 } from "./signing.ts";

export const RECOVERY_SEED_BYTES = 32;

/** 生成律所恢复托管密钥对（X25519；公钥收各事项密钥的恢复包裹，私钥离线分持）。 */
export function generateRecoveryEscrow(): { publicKeyPem: string; privateKeyPem: string } {
  const pair = generateKeyPairSync("x25519");
  return {
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

/** 把托管私钥的 32 字节种子按 threshold-of-total 分持；附 sha256(种子) 供重组校验。 */
export function splitRecoveryPrivateKey(
  privateKeyPem: string,
  total: number,
  threshold: number,
): { shares: Share[]; privateKeyHash: string } {
  const seed = x25519PrivateSeed(privateKeyPem);
  return { shares: splitSecret(seed, total, threshold), privateKeyHash: sha256B64(seed) };
}

export type CombineRecoveryResult = { ok: true; privateKeyPem: string } | { ok: false; reason: string };

/** 重组托管私钥：先插值出种子，再用 privateKeyHash 校验；不符返回 ok:false（不得静默返回错误密钥）。 */
export function combineRecoveryPrivateKey(shares: Share[], privateKeyHash: string): CombineRecoveryResult {
  const seed = combineShares(shares, RECOVERY_SEED_BYTES);
  if (sha256B64(seed) !== privateKeyHash) {
    return { ok: false, reason: "重组结果与 privateKeyHash 不符：份额不足、份额有误或 hash 错配，未返回密钥" };
  }
  return { ok: true, privateKeyPem: x25519PrivateKeyPemFromSeed(seed) };
}

export interface BreakGlassRecord {
  record_id: string;
  kind: "break_glass";
  matter_id: string;
  key_epoch: number;
  share_holder_ids: string[];
  actor_id: string;
  at: string;
}

/** 构造「动用即破窗」审计记录（纯数据；写入审计链、持有人签名与成员通知由内核做）。 */
export function createBreakGlassRecord(input: { matterId: string; keyEpoch: number; shareHolderIds: string[]; actorId: string; at: string }): BreakGlassRecord {
  if (!input.matterId) throw new KeysError("validation", "破窗记录缺少 matterId");
  if (!Number.isInteger(input.keyEpoch) || input.keyEpoch < 0) throw new KeysError("validation", "keyEpoch 须为非负整数");
  if (!Array.isArray(input.shareHolderIds) || input.shareHolderIds.length === 0 || input.shareHolderIds.some((s) => !s)) {
    throw new KeysError("validation", "破窗记录须列出全部参与持有人 shareHolderIds");
  }
  if (!input.actorId) throw new KeysError("validation", "破窗记录缺少 actorId");
  if (Number.isNaN(Date.parse(input.at))) throw new KeysError("validation", "at 须为合法时间串");
  return {
    record_id: `bg_${randomUUID()}`,
    kind: "break_glass",
    matter_id: input.matterId,
    key_epoch: input.keyEpoch,
    share_holder_ids: [...input.shareHolderIds],
    actor_id: input.actorId,
    at: input.at,
  };
}

/** 破窗记录内容哈希（canonicalJson 后 sha256，base64url；供审计链锚定）。 */
export function hashBreakGlassRecord(record: BreakGlassRecord): string {
  return sha256B64(canonicalJson(record));
}
