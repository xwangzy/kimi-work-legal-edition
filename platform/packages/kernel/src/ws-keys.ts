/**
 * 事项工作区密钥（审计 S3 / 隐私 P0-3 / ZP-9；迁移 0020）：本机 Agent 引擎会话、事件日志、工作区与材料快照的落盘加密根。
 *
 * - 每台设备每个事项一把随机 32 字节密钥（代 gen 从 1 起），以本机设备加密公钥包裹存加密账本，不随同步外发；
 * - 宿主只拿到按用途派生的区密钥（@zr-legal/at-rest deriveZoneKey），拿不到工作区密钥本身与事项密钥；
 * - 首次为该事项启动 Agent 运行时生成（失败即不启动：失败关闭）；本机用户被移出事项、本设备被吊销或事项删除时删除（加密擦除）。
 */
import { randomBytes } from "node:crypto";
import { deriveZoneKey, ZONE_PURPOSES, type ZonePurpose } from "@zr-legal/at-rest";
import { unwrapMatterKey, wrapMatterKey } from "@zr-legal/keys";
import type { KernelDb } from "./db.ts";

export interface WsKeyDeps {
  db: KernelDb;
  deviceId: string;
  encPublicKeyPem: string;
  encPrivateKeyPem: string;
}

/** 下发给宿主的形态：当前代 + 各代各用途的区密钥（base64）。 */
export interface ZoneKeysWire {
  gen_current: number;
  keys: Record<string, Record<ZonePurpose, string>>;
}

/** 确保本机持有该事项的工作区密钥（没有就生成第 1 代）。 */
export function ensureWsKey(d: WsKeyDeps, matterId: string): number {
  const cur = d.db.get<{ g: number | null }>(`SELECT MAX(gen) AS g FROM matter_ws_keys WHERE matter_id = ? AND device_id = ? AND retired_at IS NULL`, [matterId, d.deviceId]);
  if (cur?.g) return cur.g;
  const key = randomBytes(32);
  try {
    d.db.run(`INSERT OR IGNORE INTO matter_ws_keys (matter_id, gen, device_id, wrapped_key) VALUES (?,?,?,?)`, [matterId, 1, d.deviceId, wrapMatterKey(key, d.encPublicKeyPem)]);
  } finally {
    key.fill(0);
  }
  return 1;
}

/** 某事项全部未退役代的区密钥（只在内存中派生；工作区密钥用后清零）。 */
export function zoneKeysFor(d: WsKeyDeps, matterId: string): ZoneKeysWire {
  const gen = ensureWsKey(d, matterId);
  const rows = d.db.all<{ gen: number; wrapped_key: string }>(
    `SELECT gen, wrapped_key FROM matter_ws_keys WHERE matter_id = ? AND device_id = ? AND retired_at IS NULL ORDER BY gen`,
    [matterId, d.deviceId],
  );
  const keys: ZoneKeysWire["keys"] = {};
  for (const r of rows) {
    const ws = Buffer.from(unwrapMatterKey(r.wrapped_key, d.encPrivateKeyPem));
    try {
      keys[String(r.gen)] = Object.fromEntries(ZONE_PURPOSES.map((p) => [p, deriveZoneKey(ws, p).toString("base64")])) as Record<ZonePurpose, string>;
    } finally {
      ws.fill(0);
    }
  }
  return { gen_current: gen, keys };
}

/** 加密擦除：删除本机该事项的全部工作区密钥（调用方先关闭引擎并删除 kap/<事项> 目录）。 */
export function purgeWsKeys(db: KernelDb, matterId: string): number {
  return db.run(`DELETE FROM matter_ws_keys WHERE matter_id = ?`, [matterId]).changes;
}
