/**
 * 块加解密提供者（§5.1）：以 matter_keys 包裹行 + 本机设备私钥解析事项密钥（内存缓存）。
 * 当前写入用事项最新 epoch；读取按块头 (matter_id, epoch) 解析——轮换后旧块仍可解、新块用新纪元。
 */
import { unwrapMatterKey } from "@zr-legal/keys";
import type { KernelDb } from "./db.ts";
import { blobHeaderOf, isSealedBlob, openBlob, sealBlob, type BlobCipher } from "./blobs.ts";

export function createBlobCipher(deps: {
  db: KernelDb;
  deviceId: string;
  encPrivateKeyPem: string;
  /** 链模式的加密纪元（第 12 批复核 S12B-31/32）：有成员链的事项返回链上已声明、本机持有胜者密钥的最高纪元；没有链返回 undefined；有链却没有可用纪元返回 null。 */
  chainEpoch?: (matterId: string) => number | null | undefined;
}): BlobCipher {
  const { db, deviceId, encPrivateKeyPem } = deps;
  const currentEpoch = (matterId: string): number => {
    const c = deps.chainEpoch?.(matterId);
    if (c === null) throw new Error(`本机还没有事项 ${matterId} 成员链上当前纪元的密钥，暂不能写入新材料（等负责人的电脑同步后再试）`);
    if (typeof c === "number") return c;
    // 本机持有包裹的最高纪元（第 11 批复核 S11A-02：同步送来的、没有本机包裹的纪元不改变加密密钥）
    return db.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [matterId, deviceId])?.e ?? 1;
  };
  const cache = new Map<string, Buffer>();

  function resolveKey(matterId: string, epoch: number): Buffer {
    const k = `${matterId}|${epoch}`;
    const hit = cache.get(k);
    if (hit) return hit;
    const row = db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [matterId, epoch, deviceId]);
    if (!row) throw new Error(`本机不持有事项 ${matterId} 纪元 ${epoch} 的密钥（非成员设备或未同步分发）`);
    const key = Buffer.from(unwrapMatterKey(row.wrapped_key, encPrivateKeyPem));
    cache.set(k, key);
    return key;
  }

  return {
    encrypt(matterId, plain) {
      const epoch = currentEpoch(matterId);
      return sealBlob(matterId, resolveKey(matterId, epoch), epoch, plain);
    },
    currentEpoch,
    decrypt(envelope) {
      if (!isSealedBlob(envelope)) return envelope; // 明文例外（无事项归属的内部块）
      const h = blobHeaderOf(envelope)!;
      return openBlob(resolveKey(h.matterId, h.epoch), envelope);
    },
    forget(matterId) {
      for (const [k, key] of cache) {
        if (k.startsWith(`${matterId}|`)) {
          key.fill(0);
          cache.delete(k);
        }
      }
    },
  };
}
