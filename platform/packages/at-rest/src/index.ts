/**
 * @zr-legal/at-rest —— 本机落盘加密（2026-10-13 审计 S3 / 隐私安全审查 P0-3 / 第 04 篇 ZP-9；设计见 docs/audit-2026-10-13/设计-工作区与会话落盘加密.md §3）。
 *
 * 目标：律师电脑被拷盘（不知道 Windows 登录密码）时，Agent 引擎会话、事件日志与工作区里读不出案卷内容；任何时刻盘上只有密文。
 *
 * 密钥：每台设备每个事项一把随机“事项工作区密钥” K_ws（内核生成，以本机设备公钥包裹存加密账本，不随同步外发）；
 *   K_zone = HKDF-SHA256(K_ws, salt="kwl-at-rest-v1", info="zone:" ‖ 用途)；宿主只拿到各用途的 K_zone（拿不到 K_ws 与事项密钥）；
 *   K_file = HKDF-SHA256(K_zone, salt=文件头随机 32 字节, info="file")——每次整文件写入换盐，同一文件的两版不共用密钥。
 *
 * 文件格式 KWE1（头 64 字节，作为每个分块/记录的附加认证数据）：
 *   "KWE1"(4) | ver=1(1) | kind(1：0x01 分块整文件 / 0x02 追加日志) | flags(2) | gen(u32 LE) | zoneTag(u32) | chunk(u32) | salt(32) | 保留(12)
 *   0x01：每块 [nonce 12][密文 ≤ chunk][tag 16]，AAD = 头 ‖ 块序号(u64) ‖ 末块标志(u8)（防截断、防重排）；空文件 = 1 个空块；
 *         明文长度由盘上长度闭式算出（plainSizeOf）。
 *   0x02：每条记录 [len u32][nonce 12][密文 len][tag 16]，AAD = 头 ‖ 记录序号(u64)；断电写了一半的残尾按长度/认证失败识别，读时丢弃。
 * 不加密文件名（如实残余）；AAD 不含路径（broker 有纯目录项的更名与暂存操作）——同区内整文件互换不能检出，不影响机密性。
 *
 * 构造是标准的分块 AEAD（STREAM）与逐记录 AEAD，只用 Node crypto（AES-256-GCM、HKDF），不引入新依赖、不自创原语（第 02 篇 §9.11）。
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export const MAGIC = Buffer.from("KWE1", "ascii");
export const HEADER_BYTES = 64;
export const CHUNK_BYTES = 65_536;
const NONCE = 12;
const TAG = 16;
const OVERHEAD = NONCE + TAG;
/** 单条追加日志记录的明文上限（引擎整文件写入为一条记录；超过即判长度字段损坏）。 */
const MAX_LOG_RECORD = 1024 * 1024 * 1024;
/** 长度越过文件尾时向后探查的范围：其后若还有能认证通过的记录，说明是中段损坏而不是断电残尾。 */
const TORN_PROBE_BYTES = 4 * 1024 * 1024;
const KIND_CHUNKED = 0x01;
const KIND_LOG = 0x02;
const SALT_OFFSET = 20;

/** 用途：工作区、材料快照、引擎状态区（broker engine 区与存储服务共用）、引擎事件日志。 */
export type ZonePurpose = "work" | "materials" | "engine_fs" | "engine_journal";
export const ZONE_PURPOSES: readonly ZonePurpose[] = ["work", "materials", "engine_fs", "engine_journal"];

export class AtRestError extends Error {
  readonly code: "not_sealed" | "unknown_gen" | "wrong_zone" | "corrupt" | "auth_failed";
  constructor(code: AtRestError["code"], message: string) {
    super(message);
    this.name = "AtRestError";
    this.code = code;
  }
}

/** 由事项工作区密钥派生某用途的区密钥（内核侧调用；宿主只拿结果）。 */
export function deriveZoneKey(wsKey: Uint8Array, purpose: ZonePurpose): Buffer {
  if (wsKey.length !== 32) throw new AtRestError("corrupt", "事项工作区密钥须为 32 字节");
  return Buffer.from(hkdfSync("sha256", wsKey, Buffer.from("kwl-at-rest-v1"), Buffer.from(`zone:${purpose}`), 32));
}

function zoneTagOf(purpose: string): number {
  return createHash("sha256").update(`kwl-zone:${purpose}`).digest().readUInt32LE(0);
}

function fileKey(zoneKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", zoneKey, salt, Buffer.from("file"), 32));
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function header(kind: number, gen: number, purpose: string): Buffer {
  const h = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(h, 0);
  h[4] = 1;
  h[5] = kind;
  h.writeUInt32LE(gen >>> 0, 8);
  h.writeUInt32LE(zoneTagOf(purpose), 12);
  h.writeUInt32LE(CHUNK_BYTES, 16);
  randomBytes(32).copy(h, SALT_OFFSET);
  return h;
}

/** 是否是 KWE1 密文（只看魔数与版本）。 */
export function isSealed(buf: Uint8Array): boolean {
  return buf.length >= HEADER_BYTES && Buffer.from(buf.buffer, buf.byteOffset, 4).equals(MAGIC) && buf[4] === 1;
}

/**
 * 分块格式的盘上长度是否结构合法（复核 S3B-A03）：头之后是若干个满块，再加一个 28 字节以上的残块（没有残块时最后一个满块就是末块）；
 * 空文件恰好是一个 28 字节的空块（盘上 92 字节）。只剩文件头、或残片不足 28 字节，都是被截断的文件。
 */
export function isValidChunkedSize(diskSize: number): boolean {
  const body = diskSize - HEADER_BYTES;
  if (body < OVERHEAD) return false;
  const rem = body % (CHUNK_BYTES + OVERHEAD);
  return rem === 0 || rem >= OVERHEAD;
}

/** 分块格式的明文长度（由盘上长度闭式算出；只适用于 kind=0x01）。结构不合法的长度见 isValidChunkedSize。 */
export function plainSizeOf(diskSize: number): number {
  const body = diskSize - HEADER_BYTES;
  if (body < OVERHEAD) return 0;
  const n = Math.max(1, Math.ceil(body / (CHUNK_BYTES + OVERHEAD)));
  return Math.max(0, body - OVERHEAD * n);
}

function seal(key: Buffer, nonce: Buffer, aad: Buffer, plain: Uint8Array): Buffer {
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}

function open(key: Buffer, aad: Buffer, boxed: Buffer): Buffer {
  const nonce = boxed.subarray(0, NONCE);
  const tag = boxed.subarray(boxed.length - TAG);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(aad);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(boxed.subarray(NONCE, boxed.length - TAG)), d.final()]);
  } catch {
    throw new AtRestError("auth_failed", "密文认证失败（文件被改动、截断或用错了密钥）");
  }
}

export interface LogReadResult {
  plain: Buffer;
  records: number;
  /** 有效部分的字节长度（其后是断电留下的残尾，追加前应截断）。 */
  validLength: number;
  torn: boolean;
}

/**
 * 一个用途的编解码器：持有该用途各代（gen）的区密钥；写入用当前代，读取按文件头的代取密钥。
 */
export class ZoneCodec {
  readonly purpose: ZonePurpose;
  private readonly keys: Map<number, Buffer>;
  private readonly current: number;
  private readonly tag: number;

  constructor(purpose: ZonePurpose, keys: ReadonlyMap<number, Uint8Array>, current: number) {
    if (!keys.has(current)) throw new AtRestError("unknown_gen", "当前代的区密钥缺失");
    this.purpose = purpose;
    this.keys = new Map([...keys].map(([g, k]) => [g, Buffer.from(k)]));
    this.current = current;
    this.tag = zoneTagOf(purpose);
  }

  /** 清零内存中的密钥（事项引擎关闭时；尽力而为）。 */
  wipe(): void {
    for (const k of this.keys.values()) k.fill(0);
    this.keys.clear();
  }

  private headerKey(h: Buffer): Buffer {
    if (!isSealed(h)) throw new AtRestError("not_sealed", "不是 KWE1 密文");
    if (h.readUInt32LE(12) !== this.tag) throw new AtRestError("wrong_zone", "密文不属于这个用途");
    const zk = this.keys.get(h.readUInt32LE(8));
    if (!zk) throw new AtRestError("unknown_gen", "密文的密钥代已不可用");
    return fileKey(zk, h.subarray(SALT_OFFSET, SALT_OFFSET + 32));
  }

  /** 整文件封装（分块格式）。 */
  seal(plain: Uint8Array): Buffer {
    const h = header(KIND_CHUNKED, this.current, this.purpose);
    const fk = this.headerKey(h);
    const out: Buffer[] = [h];
    const n = Math.max(1, Math.ceil(plain.length / CHUNK_BYTES));
    for (let i = 0; i < n; i++) {
      const part = plain.subarray(i * CHUNK_BYTES, Math.min(plain.length, (i + 1) * CHUNK_BYTES));
      out.push(seal(fk, randomBytes(NONCE), Buffer.concat([h, u64(i), Buffer.from([i === n - 1 ? 1 : 0])]), part));
    }
    return Buffer.concat(out);
  }

  /** 解封：分块格式与追加日志格式都认（日志格式丢弃残尾）。 */
  open(disk: Uint8Array): Buffer {
    const buf = Buffer.from(disk.buffer, disk.byteOffset, disk.byteLength);
    const h = buf.subarray(0, HEADER_BYTES);
    if (!isSealed(h)) throw new AtRestError("not_sealed", "不是 KWE1 密文");
    if (h[5] === KIND_LOG) return this.readLog(buf).plain;
    if (h[5] !== KIND_CHUNKED) throw new AtRestError("corrupt", "未知的 KWE1 类型");
    const fk = this.headerKey(h);
    const body = buf.subarray(HEADER_BYTES);
    const step = CHUNK_BYTES + OVERHEAD;
    const n = Math.max(1, Math.ceil(body.length / step));
    if (body.length < OVERHEAD) throw new AtRestError("corrupt", "密文过短（被截断）");
    const parts: Buffer[] = [];
    for (let i = 0; i < n; i++) {
      const boxed = body.subarray(i * step, Math.min(body.length, (i + 1) * step));
      if (boxed.length < OVERHEAD) throw new AtRestError("corrupt", "密文分块残缺（被截断）");
      parts.push(open(fk, Buffer.concat([h, u64(i), Buffer.from([i === n - 1 ? 1 : 0])]), boxed));
    }
    return Buffer.concat(parts);
  }

  /** 明文长度：分块格式按盘上长度闭式算出；日志格式须扫描记录头（不解密）。 */
  plainSize(disk: Uint8Array): number {
    const buf = Buffer.from(disk.buffer, disk.byteOffset, disk.byteLength);
    if (!isSealed(buf)) return buf.length;
    if (buf[5] === KIND_CHUNKED) return plainSizeOf(buf.length);
    let at = HEADER_BYTES;
    let total = 0;
    while (at + 4 <= buf.length) {
      const len = buf.readUInt32LE(at);
      if (at + 4 + OVERHEAD + len > buf.length) break;
      total += len;
      at += 4 + OVERHEAD + len;
    }
    return total;
  }

  /** 新的空追加日志（只有头）。 */
  newLog(): Buffer {
    return header(KIND_LOG, this.current, this.purpose);
  }

  /** 追加一条记录：返回要写在文件末尾的字节（调用方先按 readLog 的 validLength 截断残尾）。 */
  record(logHeader: Uint8Array, index: number, plain: Uint8Array): Buffer {
    const h = Buffer.from(logHeader.buffer, logHeader.byteOffset, HEADER_BYTES);
    if (h[5] !== KIND_LOG) throw new AtRestError("corrupt", "不是追加日志");
    const fk = this.headerKey(h);
    const boxed = seal(fk, randomBytes(NONCE), Buffer.concat([h, u64(index)]), plain);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(plain.length);
    return Buffer.concat([len, boxed]);
  }

  /**
   * 读追加日志：逐条认证解密。只有文件末尾的情况算断电残尾（最后一条长度不够，或最后一条恰好到文件尾却认证失败）；
   * 中段某条认证失败而其后还有数据（磁盘位翻转、坏扇区、两个写入者交错）抛 corrupt——不能当残尾截掉其后的有效记录（复核 B3-A17）。
   */
  readLog(disk: Uint8Array): LogReadResult {
    const buf = Buffer.from(disk.buffer, disk.byteOffset, disk.byteLength);
    const h = buf.subarray(0, HEADER_BYTES);
    if (!isSealed(h) || h[5] !== KIND_LOG) throw new AtRestError("not_sealed", "不是追加日志");
    const fk = this.headerKey(h);
    const parts: Buffer[] = [];
    let at = HEADER_BYTES;
    let i = 0;
    while (at < buf.length) {
      if (at + 4 > buf.length) break;
      const len = buf.readUInt32LE(at);
      // 长度字段本身损坏（复核 C-A17 部分）：超出单条记录可能的大小即判损坏，不当残尾截断；长度合理而越过文件尾才是断电残尾
      if (len > MAX_LOG_RECORD) throw new AtRestError("corrupt", `追加日志第 ${i + 1} 条记录的长度字段不合理（${len}），判为损坏`);
      const end = at + 4 + OVERHEAD + len;
      if (end > buf.length) {
        if (this.laterRecordAuthenticates(fk, h, buf, at, i)) throw new AtRestError("corrupt", `追加日志第 ${i + 1} 条记录的长度字段损坏（其后还有有效记录），不按残尾截断`);
        break;
      }
      try {
        parts.push(open(fk, Buffer.concat([h, u64(i)]), buf.subarray(at + 4, end)));
      } catch {
        if (end < buf.length) throw new AtRestError("corrupt", `追加日志第 ${i + 1} 条记录认证失败且其后还有数据（中段损坏，不按残尾截断）`);
        break;
      }
      at = end;
      i++;
    }
    return { plain: Buffer.concat(parts), records: i, validLength: at, torn: at < buf.length };
  }

  /**
   * 长度字段指向文件尾之外时：在其后的字节里找“能以下一序号认证通过”的记录起点。找到即说明本条长度字段损坏、其后仍有有效记录
   * （真正的断电残尾之后不会再有完整记录）。只在失败路径上运行；长度不合理的位置直接跳过，实际解密尝试很少。
   */
  private laterRecordAuthenticates(fk: Buffer, h: Buffer, buf: Buffer, at: number, i: number): boolean {
    const limit = Math.min(buf.length - 4, at + TORN_PROBE_BYTES);
    for (let p = at + 4 + OVERHEAD; p <= limit; p++) {
      const len = buf.readUInt32LE(p);
      const end = p + 4 + OVERHEAD + len;
      if (end > buf.length) continue;
      try {
        open(fk, Buffer.concat([h, u64(i + 1)]), buf.subarray(p + 4, end));
        return true;
      } catch {
        // 不是记录起点
      }
    }
    return false;
  }

  /** 头里的代是否落后于当前代（追加日志遇到时整文件按新代重写）。 */
  isCurrentGen(disk: Uint8Array): boolean {
    return isSealed(disk) && Buffer.from(disk.buffer, disk.byteOffset, HEADER_BYTES).readUInt32LE(8) === this.current;
  }

  /**
   * 分块格式的随机读（审计 S3 第 2 步：broker 的 readBytes(n, offset) 只解所需分块）：`boxed` 是从第 `first` 块起连续的若干个完整分块
   * （盘上字节，由 chunkSpan 给出位置），`total` 是文件的总块数（末块标志参与认证，读到的是不是末块由它判定）。
   */
  openChunks(header: Uint8Array, first: number, total: number, boxed: Uint8Array): Buffer {
    const h = Buffer.from(header.buffer, header.byteOffset, HEADER_BYTES);
    if (h[5] !== KIND_CHUNKED) throw new AtRestError("corrupt", "不是分块格式");
    const fk = this.headerKey(h);
    const step = CHUNK_BYTES + OVERHEAD;
    const buf = Buffer.from(boxed.buffer, boxed.byteOffset, boxed.byteLength);
    const parts: Buffer[] = [];
    for (let at = 0, i = first; at < buf.length; at += step, i++) {
      const box = buf.subarray(at, Math.min(buf.length, at + step));
      if (box.length < OVERHEAD || i >= total) throw new AtRestError("corrupt", "密文分块残缺（被截断）");
      parts.push(open(fk, Buffer.concat([h, u64(i), Buffer.from([i === total - 1 ? 1 : 0])]), box));
    }
    return Buffer.concat(parts);
  }

  /** 交给另一线程或进程（执行域读层）的形态：本用途各代区密钥（base64）。调用方负责只交给可信的同机组件。 */
  toWire(): ZoneKeysOfPurpose {
    return { purpose: this.purpose, gen_current: this.current, keys: Object.fromEntries([...this.keys].map(([g, k]) => [String(g), k.toString("base64")])) };
  }

  static fromWire(w: ZoneKeysOfPurpose): ZoneCodec {
    if (!ZONE_PURPOSES.includes(w.purpose)) throw new AtRestError("corrupt", "未知用途");
    const decoded = new Map(Object.entries(w.keys).map(([g, k]) => [Number(g), Buffer.from(k, "base64")]));
    try {
      return new ZoneCodec(w.purpose, decoded, w.gen_current);
    } finally {
      for (const k of decoded.values()) k.fill(0); // 构造器已复制（复核 S3B-A09：解码出的中间缓冲清零）
    }
  }
}

/** 单一用途的区密钥（跨线程/进程传递形态）。 */
export interface ZoneKeysOfPurpose {
  purpose: ZonePurpose;
  gen_current: number;
  keys: Record<string, string>;
}

/**
 * 分块格式里明文区间 [start, end) 落在哪些分块（随机读）：返回首块序号、块数、盘上起止偏移与总块数。
 * end 超过明文长度时截到文件尾；区间为空时 count = 0。
 */
export function chunkSpan(diskSize: number, start: number, end: number): { first: number; count: number; diskStart: number; diskEnd: number; total: number; plainSize: number } {
  if (!isValidChunkedSize(diskSize)) throw new AtRestError("corrupt", "密文分块残缺（被截断）");
  const plainSize = plainSizeOf(diskSize);
  const step = CHUNK_BYTES + OVERHEAD;
  const total = Math.max(1, Math.ceil((diskSize - HEADER_BYTES) / step));
  const s = Math.max(0, Math.min(start, plainSize));
  const e = Math.max(s, Math.min(end, plainSize));
  if (e === s) return { first: 0, count: 0, diskStart: HEADER_BYTES, diskEnd: HEADER_BYTES, total, plainSize };
  const first = Math.floor(s / CHUNK_BYTES);
  const last = Math.floor((e - 1) / CHUNK_BYTES);
  return { first, count: last - first + 1, diskStart: HEADER_BYTES + first * step, diskEnd: Math.min(diskSize, HEADER_BYTES + (last + 1) * step), total, plainSize };
}

/** 末块（第 total−1 块）在盘上的位置：随机读的区间不含末块时另认证它（复核 S3B-A03：截断、只剩文件头都不能被当成“更短”或“空文件”）。 */
export function lastChunkSpan(diskSize: number): { index: number; total: number; diskStart: number; diskEnd: number } {
  if (!isValidChunkedSize(diskSize)) throw new AtRestError("corrupt", "密文分块残缺（被截断）");
  const step = CHUNK_BYTES + OVERHEAD;
  const total = Math.max(1, Math.ceil((diskSize - HEADER_BYTES) / step));
  return { index: total - 1, total, diskStart: HEADER_BYTES + (total - 1) * step, diskEnd: diskSize };
}

/** 是否是分块格式的 KWE1 头（区分追加日志）。 */
export function isChunkedHeader(h: Uint8Array): boolean {
  return isSealed(h) && h[5] === KIND_CHUNKED;
}

/** 事项工作区各用途的区密钥（宿主内存持有；关闭事项引擎时清零）。 */
export class MatterKeyRing {
  private readonly codecs = new Map<ZonePurpose, ZoneCodec>();

  /** keys：gen → 用途 → 区密钥（内核经 IPC 下发的形态，base64 已解码）。 */
  constructor(current: number, keys: ReadonlyMap<number, Partial<Record<ZonePurpose, Uint8Array>>>) {
    for (const p of ZONE_PURPOSES) {
      const byGen = new Map<number, Uint8Array>();
      for (const [g, z] of keys) if (z[p]) byGen.set(g, z[p]!);
      if (byGen.has(current)) this.codecs.set(p, new ZoneCodec(p, byGen, current));
    }
  }

  static fromWire(w: { gen_current: number; keys: Record<string, Partial<Record<ZonePurpose, string>>> }): MatterKeyRing {
    const m = new Map<number, Partial<Record<ZonePurpose, Uint8Array>>>();
    for (const [g, z] of Object.entries(w.keys ?? {})) {
      const out: Partial<Record<ZonePurpose, Uint8Array>> = {};
      for (const p of ZONE_PURPOSES) if (typeof z[p] === "string") out[p] = Buffer.from(z[p]!, "base64");
      m.set(Number(g), out);
    }
    try {
      return new MatterKeyRing(w.gen_current, m);
    } finally {
      for (const z of m.values()) for (const k of Object.values(z)) k?.fill(0); // 编解码器已复制（复核 S3B-A09）
    }
  }

  zone(p: ZonePurpose): ZoneCodec {
    const c = this.codecs.get(p);
    if (!c) throw new AtRestError("unknown_gen", `缺少用途 ${p} 的区密钥`);
    return c;
  }

  wipe(): void {
    for (const c of this.codecs.values()) c.wipe();
    this.codecs.clear();
  }
}

/** 两段字节常量时间比较（测试与校验用）。 */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
