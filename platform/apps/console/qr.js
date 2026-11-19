/**
 * 二维码编码（无依赖；ISO/IEC 18004）：只做两步验证绑定要用的那一种——字节模式、纠错等级 M、版本 1–10（至多 213 字节）。
 * otpauth://totp/… 地址通常 80–180 字节，够用；更长时抛错，界面退回“手动输入密钥”。
 *
 *   encodeQr(text) → { version, size, mask, modules: boolean[][] }   // modules[y][x]，true = 深色
 *   qrPath(qr, border) → SVG path 的 d（每个深色模块一个 1×1 方块，按行合并）
 *   qrSvg(text, { border, title }) → 完整 SVG 字符串（Node 与测试用；页面里用 ui.js 以 DOM 构造同一条 path，不拼 HTML）
 *
 * 结构：数据码字 → Reed-Solomon（GF(256)，本原多项式 0x11D）→ 分块交错 → 功能图形（定位、分隔、定时、校正、暗模块、
 * 格式信息、版本信息）→ 之字形放置 → 8 种掩码按四条罚分规则取最低者 → 写格式信息（BCH(15,5)，异或 0x5412）。
 */

// 纠错 M：每版本 [每块纠错码字数, [[块数, 每块数据码字数], …]]
const EC_M = [
  null,
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
export const MAX_VERSION = 10;
const EC_BITS_M = 0b00; // L=01 M=00 Q=11 H=10

// ─── GF(256) ───
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function rsGenerator(deg) {
  let g = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gmul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}
/** 数据码字的纠错码字（多项式长除的余式） */
export function rsEcc(data, deg) {
  const g = rsGenerator(deg);
  const r = [...data, ...new Array(deg).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const c = r[i];
    if (!c) continue;
    for (let j = 1; j <= deg; j++) r[i + j] ^= gmul(g[j], c);
  }
  return r.slice(data.length);
}

const dataCodewords = (v) => EC_M[v][1].reduce((s, [n, k]) => s + n * k, 0);
const ccBits = (v) => (v <= 9 ? 8 : 16);
/** 字节模式下各版本（M）的最大字节数 */
export const capacityBytes = (v) => Math.floor((dataCodewords(v) * 8 - 4 - ccBits(v)) / 8);

function utf8(text) {
  return Array.from(new TextEncoder().encode(String(text)));
}

/** 数据位流 → 数据码字（含终止符与填充 0xEC 0x11） */
function dataBytes(bytes, v) {
  const bits = [];
  const put = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ccBits(v));
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(v) * 8;
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < dataCodewords(v); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** 分块、算纠错、交错 */
function interleave(data, v) {
  const [ecLen, groups] = EC_M[v];
  const blocks = [];
  let k = 0;
  for (const [n, len] of groups)
    for (let i = 0; i < n; i++) {
      const d = data.slice(k, k + len);
      k += len;
      blocks.push({ d, e: rsEcc(d, ecLen) });
    }
  const out = [];
  const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
export const maskFn = (m) => MASKS[m];

/** 格式信息 15 位（纠错 M + 掩码号；BCH(15,5) 后异或 0x5412） */
export function formatBits(mask) {
  const data = (EC_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}
/** 版本信息 18 位（版本 ≥ 7；BCH(18,6)，生成多项式 0x1F25） */
export function versionBits(v) {
  let rem = v;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (v << 12) | (rem & 0xfff);
}

class Grid {
  constructor(v) {
    this.v = v;
    this.size = v * 4 + 17;
    this.m = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }
  set(x, y, dark) {
    this.m[y][x] = dark;
    this.fn[y][x] = true;
  }
  functionPatterns() {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]])
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= s || y >= s) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, d !== 2 && d !== 4);
        }
    const al = ALIGN[this.v];
    const last = al.length - 1;
    for (let i = 0; i < al.length; i++)
      for (let j = 0; j < al.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    this.format(0); // 先占位，选好掩码后重写
    if (this.v >= 7) {
      const bits = versionBits(this.v);
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = s - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, dark);
        this.set(b, a, dark);
      }
    }
  }
  format(mask) {
    const s = this.size;
    const bits = formatBits(mask);
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(i));
    this.set(8, s - 8, true); // 暗模块
  }
  place(codewords) {
    const s = this.size;
    let i = 0;
    const total = codewords.length * 8;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < s; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const up = ((right + 1) & 2) === 0;
          const y = up ? s - 1 - vert : vert;
          if (this.fn[y][x]) continue;
          if (i < total) this.m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
    }
  }
  applyMask(mask) {
    const f = MASKS[mask];
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) if (!this.fn[y][x] && f(x, y)) this.m[y][x] = !this.m[y][x];
  }
}

/** 四条罚分规则（同色连续 ≥5、2×2 同色块、1:1:3:1:1 类定位图形、深浅比例） */
export function penalty(m) {
  const s = m.length;
  let p = 0;
  const line = (get) => {
    for (let a = 0; a < s; a++) {
      let run = 1;
      for (let b = 1; b <= s; b++) {
        if (b < s && get(a, b) === get(a, b - 1)) run++;
        else {
          if (run >= 5) p += 3 + (run - 5);
          run = 1;
        }
      }
      for (let b = 0; b + 11 <= s; b++) {
        const seq = Array.from({ length: 11 }, (_, k) => get(a, b + k));
        const A = [true, false, true, true, true, false, true, false, false, false, false];
        if (A.every((v, k) => seq[k] === v) || A.every((v, k) => seq[10 - k] === v)) p += 40;
      }
    }
  };
  line((y, x) => m[y][x]);
  line((x, y) => m[y][x]);
  for (let y = 0; y < s - 1; y++) for (let x = 0; x < s - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = s * s;
  p += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return p;
}

/** 编码：取能装下的最小版本；掩码按罚分取最低（也可指定 opts.mask 0–7，测试用） */
export function encodeQr(text, opts = {}) {
  const bytes = utf8(text);
  let v = 1;
  while (v <= MAX_VERSION && bytes.length > capacityBytes(v)) v++;
  if (v > MAX_VERSION) throw new Error(`二维码内容太长（${bytes.length} 字节，至多 ${capacityBytes(MAX_VERSION)}）`);
  if (opts.minVersion && opts.minVersion > v) v = Math.min(MAX_VERSION, opts.minVersion);
  const cw = interleave(dataBytes(bytes, v), v);
  let best = null;
  const tryMasks = Number.isInteger(opts.mask) ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const mask of tryMasks) {
    const g = new Grid(v);
    g.functionPatterns();
    g.place(cw);
    g.applyMask(mask);
    g.format(mask);
    const score = penalty(g.m);
    if (!best || score < best.score) best = { score, mask, g };
  }
  return { version: v, size: best.g.size, mask: best.mask, modules: best.g.m, codewords: cw };
}

/** SVG path：每行把相邻深色模块合并成一段（坐标含静区 border） */
export function qrPath(qr, border = 4) {
  const parts = [];
  qr.modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < row.length && row[x + w]) w++;
      parts.push(`M${x + border} ${y + border}h${w}v1h-${w}z`);
      x += w;
    }
  });
  return parts.join("");
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
/** 完整 SVG 字符串（浅底深码，固定黑白：扫码器不认反色） */
export function qrSvg(text, { border = 4, title = "" } = {}) {
  const qr = encodeQr(text);
  const n = qr.size + border * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">${title ? `<title>${esc(title)}</title>` : ""}<rect width="${n}" height="${n}" fill="#fff"/><path d="${qrPath(qr, border)}" fill="#000"/></svg>`;
}
