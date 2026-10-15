/**
 * 律所主秘密的分片编码 `kwl-share/1`（TPM 与根私钥离线分持设计 v1 §3.2、§3.6；C6 §7.4 第 3 项）。
 *
 * - 律所版：主秘密 FMS（32 字节）按 Shamir 2-of-3 分成三片；每片 43 字节：
 *   `ver(1)=0x01 ‖ set_id(4) ‖ (t<<4 | n)(1) ‖ x(1) ‖ y(32) ‖ check(4)`，check = SHA-256("kwl-share-v1" ‖ 前 39 字节) 前 4 字节；
 * - 团队版恢复码：不分片，`ver(1)=0x02 ‖ set_id(4) ‖ FMS(32) ‖ check(4)`，41 字节（设计稿写“无 x、无 t/n”，保留 set_id 以便轮换后区分新旧码）；
 * - 文本：前缀 `KWS1`（团队版 `KWR1`）+ Crockford base32；每 4 字符一组、每行 6 组，行末 1 位行校验字符（按位置加权、含行号，模 32），
 *   抄错时指出哪一行；整体再由 check 兜底。只提示、不自动纠错（纠错可能纠成“有效但错误”的份额）；
 * - 二维码内容：`KWS1:` + base32（全部在 QR 字母数字模式字符集内）；
 * - 标签 tag = SHA-256("kwl-share-tag-v1" ‖ 43 字节)前 8 字节，写进根签名的信任锚；季度核验只比 tag，不重建、不同时持有两片。
 *
 * 份额本身不带认证：错误的份额会插值出错误的秘密而不报错——所以每片先查 check、set_id 与 t/n，重建后由调用方比对根公钥（§3.1）。
 * 秘密只以 Uint8Array 承载，调用方用完 `fill(0)`；本模块不把秘密转成字符串。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { KeysError } from "./errors.ts";
import { combineShares, splitSecret } from "./shamir.ts";

export const FMS_BYTES = 32;
const SET_ID_BYTES = 4;
const CHECK_BYTES = 4;
const VER_FIRM = 0x01;
const VER_TEAM = 0x02;
const FIRM_SHARE_BYTES = 1 + SET_ID_BYTES + 1 + 1 + FMS_BYTES + CHECK_BYTES; // 43
const TEAM_CODE_BYTES = 1 + SET_ID_BYTES + FMS_BYTES + CHECK_BYTES; // 41
const PREFIX_FIRM = "KWS1";
const PREFIX_TEAM = "KWR1";
const GROUP = 4;
const GROUPS_PER_LINE = 6;
const LINE_CHARS = GROUP * GROUPS_PER_LINE;

/** Crockford base32（编码不含 I/L/O/U；解码时 O→0、I/L→1 容错），与 root.ts 恢复码同一字母表。 */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const B32_DECODE: Readonly<Record<string, number>> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B32.length; i++) m[B32[i]!] = i;
  m["O"] = 0;
  m["I"] = 1;
  m["L"] = 1;
  return m;
})();

export interface FirmShare {
  setId: Uint8Array;
  threshold: number;
  total: number;
  x: number;
  y: Uint8Array;
}

export interface ShareSet {
  setId: Uint8Array;
  threshold: number;
  total: number;
  /** 每片 43 字节的编码（含 check）。 */
  shares: Uint8Array[];
  /** 每片的标签（8 字节），与 shares 同序；写进信任锚 share_set.tags。 */
  tags: Uint8Array[];
}

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

function checkOf(body: Uint8Array): Uint8Array {
  return new Uint8Array(sha256(utf8("kwl-share-v1"), body).subarray(0, CHECK_BYTES));
}

/** 律所主秘密分成 t-of-n 片（律所版缺省 2-of-3）；每次调用都是新的分片集（新 set_id、新多项式）。 */
export function splitFirmMasterSecret(fms: Uint8Array, o: { threshold?: number; total?: number } = {}): ShareSet {
  const threshold = o.threshold ?? 2;
  const total = o.total ?? 3;
  if (fms.length !== FMS_BYTES) throw new KeysError("validation", `律所主秘密须为 ${FMS_BYTES} 字节`);
  if (total > 15 || threshold > 15) throw new KeysError("validation", "分片数与门限都不得超过 15（编码为半字节）");
  const setId = new Uint8Array(randomBytes(SET_ID_BYTES));
  const raw = splitSecret(fms, total, threshold);
  const shares = raw.map((s) => {
    const enc = encodeFirmShare({ setId, threshold, total, x: s.x, y: s.y });
    s.y.fill(0);
    return enc;
  });
  return { setId, threshold, total, shares, tags: shares.map(shareTag) };
}

export function encodeFirmShare(s: FirmShare): Uint8Array {
  if (s.setId.length !== SET_ID_BYTES) throw new KeysError("validation", "分片集编号须为 4 字节");
  if (s.y.length !== FMS_BYTES) throw new KeysError("validation", `份额值须为 ${FMS_BYTES} 字节`);
  if (!Number.isInteger(s.threshold) || !Number.isInteger(s.total) || s.threshold < 2 || s.threshold > s.total || s.total > 15) throw new KeysError("validation", "门限与分片数不合法");
  if (!Number.isInteger(s.x) || s.x < 1 || s.x > s.total) throw new KeysError("validation", `份额编号须为 1..${s.total}`);
  const out = new Uint8Array(FIRM_SHARE_BYTES);
  out[0] = VER_FIRM;
  out.set(s.setId, 1);
  out[5] = (s.threshold << 4) | s.total;
  out[6] = s.x;
  out.set(s.y, 7);
  out.set(checkOf(out.subarray(0, FIRM_SHARE_BYTES - CHECK_BYTES)), FIRM_SHARE_BYTES - CHECK_BYTES);
  return out;
}

/** 解析一片（先核 check 与各字段）；返回的 y 是新的副本，调用方用完清零。 */
export function decodeFirmShare(bytes: Uint8Array): FirmShare {
  if (bytes.length !== FIRM_SHARE_BYTES) throw new KeysError("share_length", `份额须为 ${FIRM_SHARE_BYTES} 字节，收到 ${bytes.length}`);
  if (bytes[0] !== VER_FIRM) throw new KeysError("share_version", "不是律所分片（版本不符）");
  const body = bytes.subarray(0, FIRM_SHARE_BYTES - CHECK_BYTES);
  if (!timingSafeEqual(checkOf(body), bytes.subarray(FIRM_SHARE_BYTES - CHECK_BYTES))) throw new KeysError("share_check", "分片校验不符：请逐行核对抄写");
  const threshold = bytes[5]! >> 4;
  const total = bytes[5]! & 0x0f;
  const x = bytes[6]!;
  if (threshold < 2 || threshold > total || x < 1 || x > total) throw new KeysError("share_fields", "分片的门限、分片数或编号不合法");
  return { setId: bytes.slice(1, 5), threshold, total, x, y: bytes.slice(7, 7 + FMS_BYTES) };
}

/**
 * 由若干片重建律所主秘密：每片先查 check；须同一分片集（set_id、t/n 一致）、编号不重复、片数不少于门限。
 * 重建结果的正确性由调用方比对“由它派生的根公钥 = 信任锚里的根公钥”（§3.1），本函数不另存秘密的哈希。
 */
export function combineFirmShares(encoded: Uint8Array[]): Uint8Array {
  if (encoded.length === 0) throw new KeysError("validation", "没有分片");
  // 逐片解析；任一片出错也要清零已解出的份额（复核 S7A-09）
  const parsed: FirmShare[] = [];
  try {
    for (const e of encoded) parsed.push(decodeFirmShare(e));
    const first = parsed[0]!;
    for (const p of parsed) {
      if (!timingSafeEqual(p.setId, first.setId)) throw new KeysError("share_set_mismatch", "分片来自不同的分片集（重新分片后旧片不能与新片混用）");
      if (p.threshold !== first.threshold || p.total !== first.total) throw new KeysError("share_set_mismatch", "分片的门限或分片数不一致");
    }
    if (new Set(parsed.map((p) => p.x)).size !== parsed.length) throw new KeysError("validation", "分片编号重复");
    if (parsed.length < first.threshold) throw new KeysError("share_insufficient", `至少需要 ${first.threshold} 片，收到 ${parsed.length} 片`);
    return combineShares(
      parsed.slice(0, first.threshold).map((p) => ({ x: p.x, y: p.y })),
      FMS_BYTES,
    );
  } finally {
    for (const p of parsed) p.y.fill(0);
  }
}

/** 分片标签：SHA-256("kwl-share-tag-v1" ‖ 43 字节)前 8 字节。 */
export function shareTag(encoded: Uint8Array): Uint8Array {
  return new Uint8Array(sha256(utf8("kwl-share-tag-v1"), encoded).subarray(0, 8));
}

/** 团队版恢复码（不分片）：`ver=0x02 ‖ set_id ‖ FMS ‖ check`。 */
export function encodeTeamRecoveryCode(fms: Uint8Array, setId: Uint8Array = new Uint8Array(randomBytes(SET_ID_BYTES))): Uint8Array {
  if (fms.length !== FMS_BYTES) throw new KeysError("validation", `律所主秘密须为 ${FMS_BYTES} 字节`);
  if (setId.length !== SET_ID_BYTES) throw new KeysError("validation", "分片集编号须为 4 字节");
  const out = new Uint8Array(TEAM_CODE_BYTES);
  out[0] = VER_TEAM;
  out.set(setId, 1);
  out.set(fms, 5);
  out.set(checkOf(out.subarray(0, TEAM_CODE_BYTES - CHECK_BYTES)), TEAM_CODE_BYTES - CHECK_BYTES);
  return out;
}

/** 解析团队版恢复码；返回的主秘密是新的副本，调用方用完清零。 */
export function decodeTeamRecoveryCode(bytes: Uint8Array): { setId: Uint8Array; fms: Uint8Array } {
  if (bytes.length !== TEAM_CODE_BYTES) throw new KeysError("share_length", `恢复码须为 ${TEAM_CODE_BYTES} 字节，收到 ${bytes.length}`);
  if (bytes[0] !== VER_TEAM) throw new KeysError("share_version", "不是团队版恢复码（版本不符）");
  if (!timingSafeEqual(checkOf(bytes.subarray(0, TEAM_CODE_BYTES - CHECK_BYTES)), bytes.subarray(TEAM_CODE_BYTES - CHECK_BYTES))) throw new KeysError("share_check", "恢复码校验不符：请逐行核对抄写");
  return { setId: bytes.slice(1, 5), fms: bytes.slice(5, 5 + FMS_BYTES) };
}

// ─── 文本与二维码 ───

function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

function fromBase32(chars: string, byteLength: number): Uint8Array {
  let bits = 0;
  let acc = 0;
  const out = new Uint8Array(byteLength);
  let n = 0;
  for (const ch of chars) {
    acc = ((acc << 5) | B32_DECODE[ch]!) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (n < byteLength) out[n] = (acc >>> bits) & 0xff;
      n++;
    }
  }
  if (n !== byteLength) {
    out.fill(0);
    throw new KeysError("share_length", `字符数不符：解出 ${n} 字节，应为 ${byteLength} 字节`);
  }
  // 只收规范编码：多余字符、末字符填充位不为 0 的写法一律拒（复核 S7A-09）
  if (toBase32(out) !== chars) {
    out.fill(0);
    throw new KeysError("share_length", "字符数或末尾字符不对");
  }
  return out;
}

/**
 * 行校验字符：按位置加权求和，并计入行号（整行抄到别的位置也能发现），模 32。
 * 权重取奇数 1、3、5……（模 32 下可逆）：任一位置抄错一个字符都会改变校验位（复核 S7A-04：原权重 1..24 中的偶数位会漏检约 6%）。
 */
function lineCheck(line: string, lineIndex: number): string {
  let sum = 7 * (lineIndex + 1);
  for (let i = 0; i < line.length; i++) sum += (2 * i + 1) * B32_DECODE[line[i]!]!;
  return B32[sum % 32]!;
}

const byteLengthFor = (prefix: string): number => (prefix === PREFIX_FIRM ? FIRM_SHARE_BYTES : TEAM_CODE_BYTES);
const prefixFor = (bytes: Uint8Array): string => {
  if (bytes[0] === VER_FIRM && bytes.length === FIRM_SHARE_BYTES) return PREFIX_FIRM;
  if (bytes[0] === VER_TEAM && bytes.length === TEAM_CODE_BYTES) return PREFIX_TEAM;
  throw new KeysError("share_version", "未知的分片或恢复码版本");
};

/**
 * 抄写用文本：第一行是前缀，其后每行 6 组（每组 4 字符），行末空两格后 1 位行校验字符。
 * 例：`KWS1\nABCD EFGH JKMN PQRS TVWX YZ01  7\n…`
 */
export function shareToText(bytes: Uint8Array): string {
  const prefix = prefixFor(bytes);
  const b32 = toBase32(bytes);
  const lines: string[] = [prefix];
  for (let i = 0, li = 0; i < b32.length; i += LINE_CHARS, li++) {
    const line = b32.slice(i, i + LINE_CHARS);
    const groups: string[] = [];
    for (let g = 0; g < line.length; g += GROUP) groups.push(line.slice(g, g + GROUP));
    lines.push(`${groups.join(" ")}  ${lineCheck(line, li)}`);
  }
  return lines.join("\n");
}

/**
 * 解析抄写文本：逐行核对行校验字符（错在哪一行就报哪一行，行号从 1 起，不含前缀行），再核整体 check。
 * 容错：大小写、O→0、I/L→1、组间空格与连字符；不做任何纠错。
 */
export function shareFromText(text: string): Uint8Array {
  const rows = text
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter(Boolean);
  // 前缀同样容错（抄成 KWSl、KWSI）
  const prefix = (rows.shift() ?? "").toUpperCase().replace(/[IL]$/, "1");
  if (prefix !== PREFIX_FIRM && prefix !== PREFIX_TEAM) throw new KeysError("share_version", `第一行应为 ${PREFIX_FIRM}（律所分片）或 ${PREFIX_TEAM}（团队版恢复码）`);
  const byteLength = byteLengthFor(prefix);
  const expectedChars = Math.ceil((byteLength * 8) / 5);
  const expectedRows = Math.ceil(expectedChars / LINE_CHARS);
  if (rows.length !== expectedRows) throw new KeysError("share_rows", `应有 ${expectedRows} 行（不含第一行），收到 ${rows.length} 行`);
  let data = "";
  rows.forEach((row, li) => {
    const clean = row.toUpperCase().replace(/[\s-]/g, "");
    for (const ch of clean) if (B32_DECODE[ch] === undefined) throw Object.assign(new KeysError("share_line", `第 ${li + 1} 行含无法识别的字符「${ch}」`), { line: li + 1 });
    const normalized = [...clean].map((ch) => B32[B32_DECODE[ch]!]).join("");
    const want = li < expectedRows - 1 ? LINE_CHARS : expectedChars - LINE_CHARS * (expectedRows - 1);
    if (normalized.length !== want + 1) throw Object.assign(new KeysError("share_line", `第 ${li + 1} 行的字符数不对（应为 ${want} 个字符加 1 位行校验）`), { line: li + 1 });
    const body = normalized.slice(0, want);
    if (lineCheck(body, li) !== normalized[want]) throw Object.assign(new KeysError("share_line", `第 ${li + 1} 行可能抄错了，请核对这一行`), { line: li + 1 });
    data += body;
  });
  return checked(fromBase32(data, byteLength), prefix);
}

/** 解出的字节先过 check 与字段校验；不通过即清零再抛（复核 S7A-09）。 */
function checked(bytes: Uint8Array, prefix: string): Uint8Array {
  try {
    if (prefix === PREFIX_FIRM) decodeFirmShare(bytes).y.fill(0);
    else decodeTeamRecoveryCode(bytes).fms.fill(0);
    return bytes;
  } catch (e) {
    bytes.fill(0);
    throw e;
  }
}

/** 二维码内容：`KWS1:` / `KWR1:` + base32（不含行校验；扫码不会抄错）。 */
export function shareToQr(bytes: Uint8Array): string {
  return `${prefixFor(bytes)}:${toBase32(bytes)}`;
}

export function shareFromQr(content: string): Uint8Array {
  const m = /^(KWS1|KWR1):([0-9A-Z]+)$/.exec(content.trim().toUpperCase());
  if (!m) throw new KeysError("share_version", "不是本产品的分片二维码");
  for (const ch of m[2]!) if (B32_DECODE[ch] === undefined) throw new KeysError("share_line", `二维码内容含无法识别的字符「${ch}」`);
  return checked(fromBase32(m[2]!, byteLengthFor(m[1]!)), m[1]!);
}

/**
 * 季度核验（§3.6）：持有人在任意已登记设备输入或扫码自己那片；只算 check 与 tag，与信任锚中的 tag 常量时间比对，
 * 不重建、不在内存里同时出现两片。份额只在本函数内以字节存在，返回前清零。
 */
export function verifyShareAgainstTags(input: { text?: string; qr?: string }, tags: Uint8Array[]): { ok: true; x: number; setId: Uint8Array } | { ok: false; code: string; line?: number } {
  let bytes: Uint8Array | null = null;
  try {
    bytes = input.qr !== undefined ? shareFromQr(input.qr) : shareFromText(input.text ?? "");
    if (bytes[0] !== VER_FIRM) return { ok: false, code: "share_version" };
    const tag = shareTag(bytes);
    const hit = tags.some((t) => t.length === tag.length && timingSafeEqual(t, tag));
    if (!hit) return { ok: false, code: "share_unknown" };
    return { ok: true, x: bytes[6]!, setId: bytes.slice(1, 5) };
  } catch (e) {
    const err = e as KeysError & { line?: number };
    return { ok: false, code: err.code ?? "share_invalid", ...(err.line ? { line: err.line } : {}) };
  } finally {
    bytes?.fill(0);
  }
}
