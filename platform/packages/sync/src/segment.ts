/**
 * 同步段文件格式（方案 §7.1：每台设备只追加写自己的段，从不改写他人文件；段不可变）。
 *
 * 一个段 = 一台设备一批事项事件，单文件 JSON：
 * - header（cleartext）：segment_id/device_id/matter_id/lamport 区间/key_epoch/event_count/
 *   created_at/device_cert_json（公开证书，接收端据此验签并校验根证书链）；
 * - key_rows（cleartext）：matter_keys 包裹行——每行已是面向特定设备的 ECIES 密文，
 *   是密钥分发通道（新成员设备先收 key_rows 才能解 body），不构成额外泄露；
 * - body：按事项密钥 AES-256-GCM 加密的 JSON 行数组（业务表可同步行）；
 * - footer：body_hash + header_hash + 设备签名（Ed25519 或 P-256，按设备公钥分派核验）。
 * - header.key_rows_hash（第 11 批复核 S11A-02）：key_rows 的摘要写进段头，随段头一起被签名——介质（共享文件夹或中继）改动、
 *   增删任何一行包裹，checkSealed 即判不符；没有此字段的旧段，其 key_rows 视为**未签名**（keyRowsSigned 为 false，摄取时不落库）。
 * 「已封口」= footer 完整、两个 hash 重算一致、签名验过（读取端只认已封口段，§7.2）。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { b64urlDecode, b64urlEncode, canonicalJson, sha256B64, signSyncWith, verifyBytes, type SyncSignerLike } from "@zr-legal/keys";

export interface SegmentHeader {
  segment_id: string;
  device_id: string;
  matter_id: string;
  from_lamport: number;
  to_lamport: number;
  key_epoch: number;
  event_count: number;
  created_at: string;
  /** 签名设备证书（公开信息；接收端验证书链 + cert.deviceId === header.device_id）。 */
  device_cert_json: string;
  /** key_rows 的规范 JSON 摘要（随段头签名；复核 S11A-02）。 */
  key_rows_hash?: string;
}

export interface SyncRow {
  /** 表名。 */
  t: string;
  /** 主键（单行主键的字符串形态）。 */
  pk: string;
  src_device: string;
  src_lamport: number;
  row: Record<string, unknown>;
}

export interface KeyRow {
  matter_id: string;
  epoch: number;
  wrapped_for: string;
  wrapped_key: string;
  created_at: string;
}

export interface SegmentFile {
  header: SegmentHeader;
  key_rows: KeyRow[];
  body: { v: 1; epoch: number; nonce: string; ct: string; tag: string };
  footer: { body_hash: string; header_hash: string; signature: string };
}

function gcmEncrypt(matterKey: Uint8Array, plain: Buffer): { nonce: string; ct: string; tag: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", matterKey, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { nonce: b64urlEncode(new Uint8Array(nonce)), ct: b64urlEncode(new Uint8Array(ct)), tag: b64urlEncode(new Uint8Array(cipher.getAuthTag())) };
}

function gcmDecrypt(matterKey: Uint8Array, body: SegmentFile["body"]): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", matterKey, new Uint8Array(b64urlDecode(body.nonce)));
  decipher.setAuthTag(new Uint8Array(b64urlDecode(body.tag)));
  return Buffer.concat([decipher.update(new Uint8Array(b64urlDecode(body.ct))), decipher.final()]);
}

export function sealSegment(input: {
  header: Omit<SegmentHeader, "device_cert_json" | "key_rows_hash"> & { device_cert_json: string };
  keyRows: KeyRow[];
  rows: SyncRow[];
  matterKey: Uint8Array;
  /** 段签名者（今天是设备软件密钥；会话签名密钥见 TPM 设计 v1 §4.2）。 */
  signer: SyncSignerLike;
}): string {
  const enc = gcmEncrypt(input.matterKey, Buffer.from(JSON.stringify(input.rows), "utf8"));
  const header: SegmentHeader = { ...input.header, key_rows_hash: keyRowsHash(input.keyRows) };
  const headerHash = sha256B64(canonicalJson(header));
  const bodyHash = sha256B64(canonicalJson(enc));
  const signature = signSyncWith(input.signer, new TextEncoder().encode(sha256B64(canonicalJson({ header_hash: headerHash, body_hash: bodyHash }))));
  const seg: SegmentFile = {
    header,
    key_rows: input.keyRows,
    body: { v: 1, epoch: input.header.key_epoch, ...enc },
    footer: { body_hash: bodyHash, header_hash: headerHash, signature },
  };
  return JSON.stringify(seg);
}

export type SealCheck = { ok: true } | { ok: false; reason: string };

/** key_rows 的摘要（规范 JSON）。 */
export function keyRowsHash(rows: readonly KeyRow[]): string {
  return sha256B64(canonicalJson(rows));
}

/** 这一段的 key_rows 是否被段签名覆盖（段头带摘要且与之相符；checkSealed 通过之后才有意义）。 */
export function keyRowsSigned(seg: SegmentFile): boolean {
  return typeof seg.header.key_rows_hash === "string" && seg.header.key_rows_hash === keyRowsHash(seg.key_rows ?? []);
}

/** 已封口校验（结构 + 双 hash + 签名；证书链与撤权校验由调用方做——它持有 devices/根公钥）。 */
export function checkSealed(seg: SegmentFile, signerPublicKeyPem: string): SealCheck {
  if (!seg?.header || !seg?.body || !seg?.footer) return { ok: false, reason: "段结构不完整（未封口）" };
  if (sha256B64(canonicalJson(seg.header)) !== seg.footer.header_hash) return { ok: false, reason: "header_hash 不符" };
  // 段头声明了包裹摘要：包裹被改动、增删即不符（复核 S11A-02）
  if (seg.header.key_rows_hash !== undefined && seg.header.key_rows_hash !== keyRowsHash(seg.key_rows ?? [])) return { ok: false, reason: "key_rows_hash 不符" };
  const { v: _v, epoch: _e, ...encRest } = seg.body;
  void _v;
  void _e;
  if (sha256B64(canonicalJson(encRest)) !== seg.footer.body_hash) return { ok: false, reason: "body_hash 不符" };
  const expect = sha256B64(canonicalJson({ header_hash: seg.footer.header_hash, body_hash: seg.footer.body_hash }));
  if (!verifyBytes(signerPublicKeyPem, new TextEncoder().encode(expect), seg.footer.signature)) return { ok: false, reason: "段签名验签失败" };
  return { ok: true };
}

export function openSegmentBody(seg: SegmentFile, matterKey: Uint8Array): SyncRow[] {
  const plain = gcmDecrypt(matterKey, seg.body);
  return JSON.parse(plain.toString("utf8")) as SyncRow[];
}

export function parseSegment(content: string): SegmentFile | null {
  try {
    const seg = JSON.parse(content) as SegmentFile;
    if (typeof seg?.header?.segment_id !== "string" || typeof seg?.body?.ct !== "string" || typeof seg?.footer?.signature !== "string") return null;
    return seg;
  } catch {
    return null;
  }
}
