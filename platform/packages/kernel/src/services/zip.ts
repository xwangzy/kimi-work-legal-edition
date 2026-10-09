/**
 * 最小 ZIP 读取器（stored + deflate），用于 v0 DOCX 文本粗提取。
 * 解析前拦截：路径穿越、压缩炸弹（§6 注入防护）——条目数、单条/总解压比与大小设上限。
 */
import { inflateRawSync } from "node:zlib";
import { DomainError } from "@zr-legal/domain";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const MAX_ENTRIES = 2000;
const MAX_RATIO = 100;
const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  compressed: Buffer;
  method: number; // 0=stored 8=deflate
  compressedSize: number;
  uncompressedSize: number;
}

export function listEntries(buf: Buffer): ZipEntry[] {
  // 从尾部找 EOCD
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
  const entries: ZipEntry[] = [];
  let totalUncompressed = 0;
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
    totalUncompressed += uncompressedSize;
    if (uncompressedSize > MAX_TOTAL_UNCOMPRESSED || totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
      throw new DomainError("unsupported_file", "解压后大小超限（疑似压缩炸弹）", 422);
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_RATIO && uncompressedSize > 1024 * 1024) {
      throw new DomainError("unsupported_file", "压缩比异常（疑似压缩炸弹）", 422);
    }
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      compressed: buf.subarray(dataStart, dataStart + compressedSize),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readEntry(entry: ZipEntry): Buffer {
  if (entry.method === 0) return Buffer.from(entry.compressed);
  if (entry.method === 8) return inflateRawSync(entry.compressed);
  throw new DomainError("unsupported_file", `不支持的 ZIP 压缩方式 ${entry.method}`, 422);
}

export function readEntryText(buf: Buffer, name: string): string | null {
  const entry = listEntries(buf).find((e) => e.name === name);
  if (!entry) return null;
  return readEntry(entry).toString("utf8");
}
