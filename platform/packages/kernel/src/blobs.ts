/**
 * 内容寻址材料块存储（§5.1：导入的副本、解析版本、OCR 结果、成果文件都按 hash 存放，不可变）。
 * 按事项密钥 AES-256-GCM 加密落盘（本阶段收尾）：**hash 仍按明文内容寻址**（内容寻址语义不变），
 * 落盘字节为二进制封装 [4B magic "KWB1"][4B epoch LE][12B nonce][ct][16B tag]。
 * 挂载原件是只读引用（file://），不复制、不加密——只有导入副本与派生块加密。
 * 密钥轮换后：旧块仍用旧 epoch 解密（块头自带 epoch），新块用新 epoch；不重加密旧块
 * （旧成员曾持有旧密钥，重加密不改变既成事实，如实注释）。既有明文开发库可弃，不做迁移。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** 块加解密提供者（内核以 matter_keys + 本机设备私钥实现；测试可直接注入）。 */
export interface BlobCipher {
  /** matterId=null → 明文例外（仅无事项归属的内部块，调用点注释说明）。 */
  encrypt(matterId: string, plain: Buffer): Buffer;
  decrypt(envelope: Buffer): Buffer;
  /** 清除内存里该事项的密钥（事项删除后；之后再读该事项的块即报“本机不持钥”）。 */
  forget?(matterId: string): void;
  /** 此刻写入该事项的块所用的纪元（第 12 批复核 S12B-31/32：链模式按链上已声明的纪元）。 */
  currentEpoch?(matterId: string): number;
}

const MAGIC = Buffer.from("KWB1");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MIDLEN_BYTES = 2;

/**
 * 事项密钥 AES-256-GCM 封装（自描述：[magic][epoch][matter_id][nonce][ct][tag]）——
 * matter_id 与 epoch 随块头：读路径无需事项上下文即可解析密钥；轮换后旧块按旧 epoch 解密。
 */
export function sealBlob(matterId: string, matterKey: Uint8Array, epoch: number, plain: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", matterKey, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const head = Buffer.alloc(4 + 4 + MIDLEN_BYTES);
  MAGIC.copy(head, 0);
  head.writeUInt32LE(epoch, 4);
  head.writeUInt16LE(Buffer.byteLength(matterId), 8);
  return Buffer.concat([head, Buffer.from(matterId, "utf8"), nonce, ct, cipher.getAuthTag()]);
}

export interface BlobEnvelope {
  matterId: string;
  epoch: number;
  plain: Buffer;
}

export function isSealedBlob(envelope: Buffer): boolean {
  return envelope.length >= 10 && envelope.subarray(0, 4).equals(MAGIC);
}

export function openBlob(matterKey: Uint8Array, envelope: Buffer): Buffer {
  if (!isSealedBlob(envelope)) throw new Error("不是有效的加密块（magic 不符或长度不足）");
  const midLen = envelope.readUInt16LE(8);
  const off = 10 + midLen;
  if (envelope.length < off + NONCE_BYTES + TAG_BYTES) throw new Error("加密块长度不足");
  const nonce = envelope.subarray(off, off + NONCE_BYTES);
  const tag = envelope.subarray(envelope.length - TAG_BYTES);
  const ct = envelope.subarray(off + NONCE_BYTES, envelope.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", matterKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function blobHeaderOf(envelope: Buffer): { matterId: string; epoch: number } | null {
  if (!isSealedBlob(envelope)) return null;
  const midLen = envelope.readUInt16LE(8);
  return { matterId: envelope.subarray(10, 10 + midLen).toString("utf8"), epoch: envelope.readUInt32LE(4) };
}

export class BlobStore {
  readonly dir: string;
  private readonly cipher: BlobCipher | null;

  constructor(dir: string, cipher?: BlobCipher | null) {
    this.dir = dir;
    this.cipher = cipher ?? null;
    mkdirSync(dir, { recursive: true });
  }

  /** 写入（hash 按明文寻址，按事项命名空间隔离）；matterId 为空走 _shared 明文例外（须有充分理由并在调用点注释）。 */
  put(buf: Buffer, matterId: string | null = null): { sha256: string; storage_uri: string } {
    const sha256 = createHash("sha256").update(buf).digest("hex");
    // 跨事项不复用密文块：同一明文在不同事项各存一份（伦理墙——读块只需本事项密钥）
    const scope = matterId ?? "_shared";
    const path = join(this.dir, scope, sha256);
    if (!existsSync(path)) {
      const stored = this.cipher && matterId ? this.cipher.encrypt(matterId, buf) : buf;
      // 临时名 → 原子改名（§7.2 同款写入纪律）
      mkdirSync(join(this.dir, scope), { recursive: true });
      const tmp = join(this.dir, scope, `.${sha256}.${process.pid}.tmp`);
      writeFileSync(tmp, stored);
      renameSync(tmp, path);
    }
    return { sha256, storage_uri: `blob://${scope}/${sha256}` };
  }

  pathOf(storageUri: string): string {
    if (storageUri.startsWith("blob://")) return join(this.dir, ...storageUri.slice("blob://".length).split("/"));
    if (storageUri.startsWith("file://")) return storageUri.slice("file://".length);
    return storageUri;
  }

  /** 删除单个块（材料隔离：复核 B3-A05）。只接受本存储的 blob:// 地址。 */
  remove(storageUri: string): void {
    const m = /^blob:\/\/([A-Za-z0-9_.-]{1,128})\/([0-9a-f]{64})$/.exec(storageUri);
    if (!m || m[1] === "..") throw new Error("非法块地址");
    rmSync(join(this.dir, m[1]!, m[2]!), { force: true });
  }

  /** 事项删除（密码学擦除）：删除该事项的块目录并清除内存里的事项密钥。 */
  purgeMatter(matterId: string): void {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(matterId) || matterId === "_shared") throw new Error("非法事项 ID");
    this.cipher?.forget?.(matterId);
    rmSync(join(this.dir, matterId), { recursive: true, force: true });
  }

  read(storageUri: string): Buffer {
    const raw = readFileSync(this.pathOf(storageUri));
    // file:// 挂载原件：只读引用，不加密（§5.1 原件引用语义）
    if (storageUri.startsWith("file://")) return raw;
    const plain = this.cipher ? this.cipher.decrypt(raw) : raw;
    // 内容寻址：块名就是明文摘要——读出的内容与名称不符即拒绝（第 11 批复核 S11A-01：同步介质送来、被预先放入的同名块不能冒充）
    const name = /^blob:\/\/[A-Za-z0-9_.-]{1,128}\/([0-9a-f]{64})$/.exec(storageUri)?.[1];
    if (name && createHash("sha256").update(plain).digest("hex") !== name) throw new Error("块内容与名称不符（可能被替换），已拒绝读取");
    return plain;
  }

  /**
   * 按此刻的加密纪元重封一个块（第 12 批复核 S12B-32：本机用链上不成立的纪元封过的块，重发前改用链上已声明的纪元）。
   * 块名是明文摘要、不变；纪元相同则不动。返回是否重封。
   */
  reseal(storageUri: string, need?: (epoch: number) => boolean): boolean {
    const m = /^blob:\/\/([A-Za-z0-9_.-]{1,128})\/([0-9a-f]{64})$/.exec(storageUri);
    if (!m || m[1] === "_shared" || !this.cipher?.currentEpoch) return false;
    const path = join(this.dir, m[1]!, m[2]!);
    if (!existsSync(path)) return false;
    const raw = readFileSync(path);
    const h = blobHeaderOf(raw);
    if (!h || h.epoch === this.cipher.currentEpoch(m[1]!) || (need && !need(h.epoch))) return false;
    const plain = this.read(storageUri);
    const tmp = join(this.dir, m[1]!, `.${m[2]!}.${process.pid}.reseal.tmp`);
    writeFileSync(tmp, this.cipher.encrypt(m[1]!, plain));
    renameSync(tmp, path);
    return true;
  }

  /** 一份块文件的字节解开后是否与块名相符（同步摄取复制块之前核对；解不开也算不符）。rel = “作用域/明文摘要”。 */
  matches(rel: string, stored: Buffer): boolean {
    const name = /^[A-Za-z0-9_.-]{1,128}\/([0-9a-f]{64})$/.exec(rel)?.[1];
    if (!name) return false;
    try {
      const plain = this.cipher && isSealedBlob(stored) ? this.cipher.decrypt(stored) : stored;
      return createHash("sha256").update(plain).digest("hex") === name;
    } catch {
      return false;
    }
  }
}
