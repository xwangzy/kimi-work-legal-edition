/**
 * ZIP 读写（stored + deflate；带注入防护：路径穿越、压缩炸弹）。
 * 写入用于产出 DOCX：本地文件头 + 中央目录，deflate 压缩。
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { DomainError } from "@zr-legal/domain";
import { stripExternalRefs } from "./external-refs.ts";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_ENTRIES = 4000;
const MAX_RATIO = 100;
const MAX_TOTAL_UNCOMPRESSED = 300 * 1024 * 1024;

export interface ZipEntryOut {
  name: string;
  data: Buffer;
}

interface ReadEntry {
  name: string;
  method: number;
  compressed: Buffer;
  /** 中央目录声明的解压后大小：解压输出以它为上限（复核 B13-O01：只信声明大小的检查挡不住“声明 1 MB、实际数 GB”的条目）。 */
  size: number;
}

export function readZipText(buf: Buffer, name: string): string | null {
  const entry = listEntries(buf).find((e) => e.name === name);
  if (!entry) return null;
  return inflateEntry(entry).toString("utf8");
}

export function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const e of listEntries(buf)) out.set(e.name, inflateEntry(e));
  return out;
}

/** 只解压需要的条目（复核 B13-O01：表格里的图片等不解压）。 */
export function readZipSelected(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const e of listEntries(buf)) if (want(e.name)) out.set(e.name, inflateEntry(e));
  return out;
}

function listEntries(buf: Buffer): ReadEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DomainError("unsupported_file", "不是有效的 ZIP/DOCX 文件", 422);
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_ENTRIES) throw new DomainError("unsupported_file", `ZIP 条目数 ${count} 超限`, 422);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ReadEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIG) throw new DomainError("unsupported_file", "ZIP 中央目录损坏", 422);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    if (name.includes("..") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
      throw new DomainError("unsupported_file", `ZIP 含可疑路径: ${name}`, 422);
    }
    total += uncompressedSize;
    if (total > MAX_TOTAL_UNCOMPRESSED) throw new DomainError("unsupported_file", "解压后大小超限（疑似压缩炸弹）", 422);
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_RATIO && uncompressedSize > 1024 * 1024) {
      throw new DomainError("unsupported_file", "压缩比异常（疑似压缩炸弹）", 422);
    }
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    entries.push({ name, method, compressed: buf.subarray(dataStart, dataStart + compressedSize), size: uncompressedSize });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inflateEntry(e: ReadEntry): Buffer {
  if (e.method === 0) {
    if (e.compressed.length !== e.size) throw new DomainError("unsupported_file", "ZIP 条目大小与声明不符", 422);
    return Buffer.from(e.compressed);
  }
  if (e.method === 8) {
    let out: Buffer;
    try {
      // 输出上限 = 声明大小 + 1：实际解压出更多即判为压缩炸弹（不再无上限解压到内存）
      out = inflateRawSync(e.compressed, { maxOutputLength: e.size + 1 });
    } catch {
      throw new DomainError("unsupported_file", "解压后大小与声明不符（疑似压缩炸弹）或数据损坏", 422);
    }
    if (out.length !== e.size) throw new DomainError("unsupported_file", "解压后大小与声明不符（疑似压缩炸弹）", 422);
    return out;
  }
  throw new DomainError("unsupported_file", `不支持的 ZIP 压缩方式 ${e.method}`, 422);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * 生成 ZIP（每个条目 deflate；按给定顺序）。OOXML 包（含 [Content_Types].xml）写出前一律去除打开时会外取的引用
 * （v9 第 04 篇 §1.2 第 3 条：Office 打开产物零外部请求；见 external-refs.ts）——本产品写出的 DOCX/XLSX 都经过这里。
 */
export function writeZip(entries: ZipEntryOut[]): Buffer {
  // OPC 部件名不区分大小写（复核 S5-B13）
  if (!entries.some((e) => e.name.toLowerCase() === "[content_types].xml")) return writeRawZip(entries);
  const files = new Map(entries.map((e) => [e.name, e.data] as const));
  stripExternalRefs(files);
  // 保持原顺序；被去除的部件不再写出
  return writeRawZip(entries.filter((e) => files.has(e.name)).map((e) => ({ name: e.name, data: files.get(e.name)! })));
}

/** 原样写出（不做 OOXML 外取引用去除）：只供 writeZip 内部与测试构造对照样本（静态检查：产品源码不得直接调用）。 */
export function writeRawZip(entries: ZipEntryOut[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const compressed = deflateRawSync(e.data, { level: 6 });
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名称
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL_SIG, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + compressed.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}
