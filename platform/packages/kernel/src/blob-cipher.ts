/**
 * 块加解密提供者（§5.1）：以 matter_keys 包裹行 + 本机设备私钥解析事项密钥（内存缓存）。
 * 当前写入用事项最新 epoch；读取按块头 (matter_id, epoch) 解析——轮换后旧块仍可解、新块用新纪元。
 */
import { unwrapMatterKey } from "@zr-legal/keys";
import { DomainError } from "@zr-legal/domain";
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
    if (c === null) throw new DomainError("conflict", `本机还没有这个事项成员链上当前纪元的密钥，暂不能写入新材料（等负责人的电脑同步后再试）`, 409);
    if (typeof c === "number") return c;
    // 本机持有包裹的最高纪元（第 11 批复核 S11A-02：同步送来的、没有本机包裹的纪元不改变加密密钥）
    return db.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [matterId, deviceId])?.e ?? 1;
  };
  const cache = new Map<string, Buffer>();

  /** 按包裹解出密钥（缓存键带包裹本身——同号纪元的包裹被换成胜者那把时自然失效，第四轮复核 S12A-21）。 */
  function keyOfWrap(matterId: string, wrapped: string): Buffer {
    const k = `${matterId}|${wrapped}`;
    const hit = cache.get(k);
    if (hit) return hit;
    const key = Buffer.from(unwrapMatterKey(wrapped, encPrivateKeyPem));
    cache.set(k, key);
    return key;
  }
  function resolveKey(matterId: string, epoch: number): Buffer {
    const row = db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [matterId, epoch, deviceId]);
    if (!row) throw new Error(`本机不持有事项 ${matterId} 纪元 ${epoch} 的密钥（非成员设备或未同步分发）`);
    return keyOfWrap(matterId, row.wrapped_key);
  }
  /** 该纪元本机曾持有、已被替换的密钥（matter_key_history）。 */
  function historyKeys(matterId: string, epoch: number): Buffer[] {
    return db
      .all<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_key_history WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [matterId, epoch, deviceId])
      .map((r) => {
        try {
          return keyOfWrap(matterId, r.wrapped_key);
        } catch {
          return null;
        }
      })
      .filter((k): k is Buffer => !!k);
  }

  return {
    encrypt(matterId, plain) {
      const epoch = currentEpoch(matterId);
      return sealBlob(matterId, resolveKey(matterId, epoch), epoch, plain);
    },
    currentEpoch,
    sealedWithCurrent(envelope) {
      if (!isSealedBlob(envelope)) return true;
      const h = blobHeaderOf(envelope)!;
      if (h.epoch !== currentEpoch(h.matterId)) return false;
      try {
        openBlob(resolveKey(h.matterId, h.epoch), envelope);
        return true;
      } catch {
        return false;
      }
    },
    decrypt(envelope) {
      if (!isSealedBlob(envelope)) return envelope; // 明文例外（无事项归属的内部块）
      const h = blobHeaderOf(envelope)!;
      try {
        return openBlob(resolveKey(h.matterId, h.epoch), envelope);
      } catch (e) {
        // 同号纪元换成胜者那把之前封的块：用历史里原先那把解（第四轮复核 S12A-24/S12B-44）
        for (const k of historyKeys(h.matterId, h.epoch)) {
          try {
            return openBlob(k, envelope);
          } catch {
            // 试下一把
          }
        }
        throw e;
      }
    },
    forget(matterId) {
      for (const [k, key] of cache) {
        // 键为“事项|包裹”
        if (k.startsWith(`${matterId}|`)) {
          key.fill(0);
          cache.delete(k);
        }
      }
    },
  };
}
