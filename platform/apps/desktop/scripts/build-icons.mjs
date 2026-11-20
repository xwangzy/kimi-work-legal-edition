/**
 * 生成应用图标（第 49 批）：build/icon.ico（Windows：exe、安装/卸载程序、快捷方式、任务栏）与 build/icon.png（1024，Linux 与开发形态），
 * 以及 build/icon.icns（macOS 应用包与 DMG；16～1024 共 10 个 PNG 条目）。
 *
 * 源文件：build/brand/Logomark_Light.svg（Kimi 官方 Logomark：黑色圆角方块 + 白色 K + 蓝点 #1783FF，原样拷贝，不改形状与比例）。
 * 每个尺寸都按目标像素直接从矢量栅格化（Skia 抗锯齿），不从大图缩小；小于 64 的帧再把“K + 蓝点”整体平移不足半像素，让竖笔落在整像素上。
 * 方块铺满（不留边）：留 1px 边会让 16px 的 K 更小更糊，见预览对照。
 * macOS（icns）例外：按苹果 macOS 图标栅格四周各留 100/1024 的边（与程序坞里其他应用的图标等大），整体等比缩放，不改形状与比例。
 * 帧格式：小于 256 的帧写 32 位 BMP（DIB + AND 掩码，NSIS 与旧版资源接口都认），256 写 PNG 压缩帧（Vista 起的标准做法）。
 *
 * 用法（在 platform 目录）：node apps/desktop/scripts/build-icons.mjs
 * 依赖：@napi-rs/canvas（仓库已有的开发依赖，scripts/make-icon.mjs 也用它）。只读仓库内源文件，不依赖下载目录。
 */
import { createCanvas, Path2D } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const buildDir = fileURLToPath(new URL("../build/", import.meta.url));
export const SOURCE_SVG = `${buildDir}brand/Logomark_Light.svg`;
export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
export const PNG_SIZE = 1024;

// ── 极小 SVG 子集解析：只认官方图标用到的 svg/g(clip-path)/clipPath/rect/path 与 fill/stroke 属性 ─────────────
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

function rectPath(a) {
  const x = Number(a.x ?? 0), y = Number(a.y ?? 0), w = Number(a.width), h = Number(a.height);
  const r = Math.min(Number(a.rx ?? a.ry ?? 0), w / 2, h / 2);
  if (!r) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  return (
    `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}` +
    `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
  );
}

/** 解析成绘制指令：{ viewBox: [w, h], ops: [{ op: "fill"|"stroke"|"clip"|"restore", d, color, alpha, width }] } */
export function parseSvg(text) {
  const svg = attrs(text.match(/<svg\b[^>]*>/)[0]);
  const [, , vw, vh] = (svg.viewBox ?? `0 0 ${svg.width} ${svg.height}`).split(/[\s,]+/).map(Number);
  const clips = {};
  for (const m of text.matchAll(/<clipPath\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/clipPath>/g)) {
    const r = m[2].match(/<rect\b[^>]*>/);
    if (r) clips[m[1]] = rectPath(attrs(r[0]));
  }
  const body = text.replace(/<defs>[\s\S]*?<\/defs>/g, "");
  const ops = [];
  const stack = [];
  for (const m of body.matchAll(/<\/g>|<(g|rect|path)\b[^>]*>/g)) {
    if (m[0] === "</g>") {
      if (stack.pop()) ops.push({ op: "restore" });
      continue;
    }
    const a = attrs(m[0]);
    if (m[1] === "g") {
      const id = a["clip-path"]?.match(/url\(#([^)]+)\)/)?.[1];
      stack.push(!!id);
      if (id) ops.push({ op: "clip", d: clips[id] });
      continue;
    }
    const d = m[1] === "rect" ? rectPath(a) : a.d;
    if (a.fill && a.fill !== "none") ops.push({ op: "fill", d, color: a.fill, alpha: Number(a["fill-opacity"] ?? 1) });
    if (a.stroke && a.stroke !== "none") ops.push({ op: "stroke", d, color: a.stroke, alpha: Number(a["stroke-opacity"] ?? 1), width: Number(a["stroke-width"] ?? 1) });
  }
  return { viewBox: [vw, vh], ops };
}

// K 竖笔左缘与顶端（Logomark 源路径里的 H/V 坐标，viewBox 单位）：小尺寸按它把“K + 蓝点”整体平移不足半像素对齐像素格，
// 形状与比例不变，只让竖笔落在整像素上（不平移时 16px 的竖笔会糊成两列灰）。
const STEM_LEFT = 48.5137, STEM_TOP = 53.7744;
export const SNAP_BELOW = 64;

/** 按 target 像素直接从矢量渲染。inset：四周留白像素；snap：小于 SNAP_BELOW 时把第一个图形（底板方块）之后的图形按竖笔对齐像素格。返回 canvas。 */
export function renderSvg(text, size, { inset = 0, snap = false } = {}) {
  const { viewBox, ops } = parseSvg(text);
  const c = createCanvas(size, size);
  const g = c.getContext("2d");
  const s = (size - 2 * inset) / Math.max(viewBox[0], viewBox[1]);
  const fx = (v) => Math.round(inset + v * s) - (inset + v * s);
  const [dx, dy] = snap && size < SNAP_BELOW ? [fx(STEM_LEFT), fx(STEM_TOP)] : [0, 0];
  g.setTransform(s, 0, 0, s, inset, inset);
  ops.forEach((o, i) => {
    if (i === 1) g.setTransform(s, 0, 0, s, inset + dx, inset + dy);
    if (o.op === "restore") return g.restore();
    if (o.op === "clip") {
      g.save();
      g.clip(new Path2D(o.d));
    } else if (o.op === "fill") {
      g.globalAlpha = o.alpha;
      g.fillStyle = o.color;
      g.fill(new Path2D(o.d));
    } else {
      g.globalAlpha = o.alpha;
      g.strokeStyle = o.color;
      g.lineWidth = o.width;
      g.stroke(new Path2D(o.d));
    }
  });
  g.globalAlpha = 1;
  return c;
}

// ── ICO 编码：ICONDIR + ICONDIRENTRY×n + 帧数据 ─────────────────────────────────────────────────────
function bmpFrame(canvas, n) {
  const px = canvas.getContext("2d").getImageData(0, 0, n, n).data; // RGBA（未预乘）
  const maskRow = Math.ceil(n / 32) * 4;
  const buf = Buffer.alloc(40 + n * n * 4 + maskRow * n);
  // BITMAPINFOHEADER：高度写 2n（XOR 位图 + AND 掩码）
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(n, 4);
  buf.writeInt32LE(n * 2, 8);
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(0, 16);
  buf.writeUInt32LE(n * n * 4 + maskRow * n, 20);
  for (let y = 0; y < n; y++) {
    const src = (n - 1 - y) * n * 4; // 自下而上
    for (let x = 0; x < n; x++) {
      const i = src + x * 4, o = 40 + (y * n + x) * 4;
      buf[o] = px[i + 2];
      buf[o + 1] = px[i + 1];
      buf[o + 2] = px[i];
      buf[o + 3] = px[i + 3];
      if (px[i + 3] === 0) buf[40 + n * n * 4 + y * maskRow + (x >> 3)] |= 0x80 >> (x & 7); // 全透明处掩码置 1
    }
  }
  return buf;
}

/** frames: [{ size, data, png }]（png 为真表示 data 是 PNG） */
export function encodeIco(frames) {
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach((f, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(f.size >= 256 ? 0 : f.size, e);
    head.writeUInt8(f.size >= 256 ? 0 : f.size, e + 1);
    head.writeUInt8(0, e + 2);
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(f.data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += f.data.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.data)]);
}

/** 解析 ICO（测试与自检用）：返回每帧 { size（目录项）, png, width, height, bpp } */
export function parseIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error("不是 ICO 文件");
  const n = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + 16 * i;
    const size = buf[e] || 256, sizeH = buf[e + 1] || 256;
    const len = buf.readUInt32LE(e + 8), off = buf.readUInt32LE(e + 12);
    const data = buf.subarray(off, off + len);
    const png = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const width = png ? data.readUInt32BE(16) : data.readInt32LE(4);
    const height = png ? data.readUInt32BE(20) : data.readInt32LE(8) / 2;
    const bpp = png ? data[24] * 4 : data.readUInt16LE(14);
    out.push({ size, sizeH, png, width, height, bpp, length: len });
  }
  return out;
}

// ── ICNS 编码（macOS）：'icns' + 总长，再接 [类型(4) + 条目长(4，含 8 字节头) + PNG] ×n ─────────────────────────────
/** 条目类型与像素：icp4/icp5 为 16/32，ic11～ic14 为 @2x，ic07～ic10 为 128～1024（10.7 起各类型都接受 PNG 负载）。 */
export const ICNS_TYPES = [["icp4", 16], ["icp5", 32], ["ic11", 32], ["ic12", 64], ["ic07", 128], ["ic13", 256], ["ic08", 256], ["ic14", 512], ["ic09", 512], ["ic10", 1024]];
/** macOS 图标栅格的留边（1024 画布四周各 100）。 */
export const ICNS_INSET = 100 / 1024;

/** entries: [{ type, data }]（data 为 PNG） */
export function encodeIcns(entries) {
  const parts = entries.map(({ type, data }) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, "latin1");
    h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "latin1");
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

/** 解析 ICNS（测试与自检用）：返回每个条目 { type, png, width, height } */
export function parseIcns(buf) {
  if (buf.toString("latin1", 0, 4) !== "icns" || buf.readUInt32BE(4) !== buf.length) throw new Error("不是 ICNS 文件");
  const out = [];
  for (let off = 8; off < buf.length; ) {
    const type = buf.toString("latin1", off, off + 4), len = buf.readUInt32BE(off + 4);
    if (len < 8 || off + len > buf.length) throw new Error(`ICNS 条目 ${type} 越界`);
    const data = buf.subarray(off + 8, off + len);
    const png = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    out.push({ type, png, width: png ? data.readUInt32BE(16) : 0, height: png ? data.readUInt32BE(20) : 0 });
    off += len;
  }
  return out;
}

export function buildIcons() {
  const svg = readFileSync(SOURCE_SVG, "utf8");
  const frames = ICO_SIZES.map((n) => {
    const c = renderSvg(svg, n, { snap: true });
    return n >= 256 ? { size: n, data: c.toBuffer("image/png"), png: true } : { size: n, data: bmpFrame(c, n), png: false };
  });
  const ico = encodeIco(frames);
  writeFileSync(`${buildDir}icon.ico`, ico);
  writeFileSync(`${buildDir}icon.png`, renderSvg(svg, PNG_SIZE).toBuffer("image/png"));
  const icns = encodeIcns(ICNS_TYPES.map(([type, n]) => ({ type, data: renderSvg(svg, n, { inset: n * ICNS_INSET, snap: true }).toBuffer("image/png") })));
  writeFileSync(`${buildDir}icon.icns`, icns);
  return { ico: ico.length, sizes: ICO_SIZES, icns: icns.length };
}

const isMain = import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const r = buildIcons();
  console.log(`[build-icons] → ${buildDir}icon.ico（${r.sizes.join("/")}，${r.ico} 字节）、icon.png（${PNG_SIZE}×${PNG_SIZE}）与 icon.icns（${r.icns} 字节）`);
}
