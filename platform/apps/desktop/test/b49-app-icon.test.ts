/**
 * 第 49 批：Windows 应用图标换成 Kimi 官方 Logomark。
 * 用测试内独立的 ICO 解析（不复用生成脚本）核对 build/icon.ico 的帧尺寸与帧头，抽查像素确认是“黑底白 K”而非旧的蓝底图；
 * 静态核对 electron-builder.yml 的四个图标字段、源 SVG 与官方 Logomark 路径一致、两个页面的 favicon 用同一标识。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const file = (p: string) => new URL(`../${p}`, import.meta.url);
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
// 官方 Logomark（KIMI-logos/Logomark/SVG/Logomark_Light.svg）的两条路径：蓝点与 K
const DOT_D =
  "M139.13 36.5137C144.237 36.5137 148.377 40.6535 148.377 45.7602C148.377 50.867 144.237 55.0068 139.13 55.0068L130.972 55.0068C130.371 55.0068 129.884 54.5198 129.884 53.919L129.884 45.7602C129.884 40.6535 134.024 36.5137 139.13 36.5137Z";
const K_D =
  "M87.2905 90.3594L122.186 55.739C122.842 55.0865 122.473 53.7744 121.625 53.7744H102.848C102.644 53.7744 102.447 53.8577 102.288 54.0174L64.6898 91.3104C64.1035 91.8866 63.2366 91.3729 63.2366 90.4496V54.8782C63.2366 54.2673 62.8351 53.7744 62.3443 53.7744H49.406C48.9152 53.7744 48.5137 54.2673 48.5137 54.8782V131.575C48.5137 132.186 48.9152 132.679 49.406 132.679H62.3443C62.8351 132.679 63.2366 132.186 63.2366 131.575V115.948C63.2366 115.615 63.3577 115.295 63.5681 115.087L75.2254 103.522C75.5058 103.244 75.8946 103.202 76.2069 103.411L107.386 126.354C112.492 129.791 118.196 131.901 123.99 132.526C124.506 132.581 124.952 132.068 124.952 131.422V116.705C124.952 116.142 124.614 115.684 124.162 115.615C120.752 115.08 117.425 113.761 114.417 111.734L87.4244 92.1921C86.8635 91.8172 86.7934 90.8523 87.2905 90.3594Z";
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Frame = { size: number; sizeH: number; bpp: number; data: Buffer };
function readIco(buf: Buffer): Frame[] {
  assert.equal(buf.readUInt16LE(0), 0, "ICONDIR.reserved");
  assert.equal(buf.readUInt16LE(2), 1, "ICONDIR.type = 1（图标）");
  const n = buf.readUInt16LE(4);
  return Array.from({ length: n }, (_, i) => {
    const e = 6 + 16 * i;
    const len = buf.readUInt32LE(e + 8), off = buf.readUInt32LE(e + 12);
    assert.ok(off + len <= buf.length, `第 ${i} 帧越界`);
    return { size: buf[e] || 256, sizeH: buf[e + 1] || 256, bpp: buf.readUInt16LE(e + 6), data: buf.subarray(off, off + len) };
  });
}
/** BMP 帧（BITMAPINFOHEADER + 自下而上 BGRA）取像素 [r, g, b, a] */
function bmpPixel(f: Frame, x: number, y: number) {
  const n = f.size, o = 40 + ((n - 1 - y) * n + x) * 4;
  return [f.data[o + 2], f.data[o + 1], f.data[o], f.data[o + 3]];
}

test("icon.ico：含 16/20/24/32/40/48/64/96/128/256 全部尺寸，每帧帧头宽高与目录项一致，256 为 PNG 压缩帧", () => {
  assert.ok(existsSync(file("build/icon.ico")), "build/icon.ico 不存在（node apps/desktop/scripts/build-icons.mjs 生成）");
  const frames = readIco(readFileSync(file("build/icon.ico")));
  const sizes = new Set(frames.map((f) => f.size));
  for (const s of SIZES) assert.ok(sizes.has(s), `缺 ${s}×${s} 帧`);
  for (const f of frames) {
    assert.equal(f.size, f.sizeH, "只放正方形帧");
    assert.equal(f.bpp, 32, `${f.size} 帧应为 32 位（带透明通道）`);
    if (f.data.subarray(0, 8).equals(PNG_SIG)) {
      assert.equal(f.data.toString("latin1", 12, 16), "IHDR");
      assert.equal(f.data.readUInt32BE(16), f.size, `${f.size} 帧 PNG 宽`);
      assert.equal(f.data.readUInt32BE(20), f.size, `${f.size} 帧 PNG 高`);
      assert.equal(f.data[25], 6, `${f.size} 帧 PNG 应为 RGBA`);
    } else {
      assert.equal(f.data.readUInt32LE(0), 40, `${f.size} 帧应为 BITMAPINFOHEADER`);
      assert.equal(f.data.readInt32LE(4), f.size, `${f.size} 帧 BMP 宽`);
      assert.equal(f.data.readInt32LE(8), f.size * 2, `${f.size} 帧 BMP 高（含 AND 掩码为 2 倍）`);
      assert.equal(f.data.readUInt16LE(14), 32);
      assert.equal(f.data.length, 40 + f.size * f.size * 4 + Math.ceil(f.size / 32) * 4 * f.size, `${f.size} 帧数据长度`);
    }
  }
  const big = frames.find((f) => f.size === 256)!;
  assert.ok(big.data.subarray(0, 8).equals(PNG_SIG), "256 帧用 PNG 压缩");
});

test("icon.ico 像素抽查：圆角处透明、底板纯黑、K 竖笔纯白（16 与 32 帧的竖笔已对齐整像素）", () => {
  const frames = readIco(readFileSync(file("build/icon.ico")));
  for (const [n, stemX, midY] of [[16, 4, 8], [32, 9, 16]] as const) {
    const f = frames.find((x) => x.size === n)!;
    assert.ok(bmpPixel(f, 0, 0)[3]! < 128, `${n}px 左上角应在圆角外（透明）`);
    const bg = bmpPixel(f, 1, midY);
    assert.ok(bg[3] === 255 && bg[0]! < 16 && bg[1]! < 16 && bg[2]! < 16, `${n}px 底板应为黑色（旧图是蓝底）：${bg}`);
    const stem = bmpPixel(f, stemX, midY);
    assert.ok(stem[0]! > 240 && stem[1]! > 240 && stem[2]! > 240, `${n}px K 竖笔应为整像素白色：${stem}`);
  }
});

test("icon.png：1024×1024 RGBA，供 Linux 与 macOS 开发形态使用", () => {
  const png = readFileSync(file("build/icon.png"));
  assert.ok(png.subarray(0, 8).equals(PNG_SIG));
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.equal(png[25], 6);
});

test("electron-builder.yml：win.icon 与 nsis 的安装、卸载、页头图标都指向 build/icon.ico", () => {
  const yml = readFileSync(file("electron-builder.yml"), "utf8");
  const block = (key: string) => {
    const m = yml.match(new RegExp(`^${key}:\\n((?:[ #].*\\n|\\n)*)`, "m"));
    assert.ok(m, `缺 ${key} 段`);
    return Object.fromEntries([...m[1]!.matchAll(/^ {2}([A-Za-z]+):\s*(\S.*)$/gm)].map((x) => [x[1], x[2]!.trim()]));
  };
  assert.equal(block("win").icon, "build/icon.ico");
  const nsis = block("nsis");
  for (const k of ["installerIcon", "uninstallerIcon", "installerHeaderIcon"]) assert.equal(nsis[k], "build/icon.ico", `nsis.${k}`);
  assert.ok(!/icon\.png/.test(yml), "不再让 electron-builder 从 png 下采样生成 ico");
});

test("源文件 build/brand/Logomark_Light.svg 与官方 Logomark 一致：180 方块 rx=45 黑底、白色 K、蓝点 #1783FF", () => {
  const svg = readFileSync(file("build/brand/Logomark_Light.svg"), "utf8");
  assert.match(svg, /viewBox="0 0 180 180"/);
  assert.match(svg, /<rect width="180" height="180" rx="45" fill="black"\/>/);
  assert.ok(svg.includes(`<path d="${DOT_D}" fill="#1783FF"/>`), "蓝点路径与官方不一致");
  assert.ok(svg.includes(`<path d="${K_D}" fill="white"/>`), "K 路径与官方不一致");
  assert.equal(svg.match(/<path\b/g)?.length, 2, "只有 K 与蓝点两条路径（不加角标或文字）");
});

test("桌面端与运营控制台的 favicon 都是同一 Logomark（内联 SVG）", () => {
  for (const p of ["index.html", "../console/index.html"]) {
    const html = readFileSync(file(p), "utf8");
    const link = html.match(/<link rel="icon" href="([^"]+)"/)?.[1] ?? "";
    assert.ok(link.startsWith("data:image/svg+xml,"), `${p} 缺内联 SVG favicon`);
    assert.ok(link.includes("viewBox='0 0 180 180'") && link.includes("%3Crect width='180' height='180' rx='45' fill='black'/%3E"), `${p} 的 favicon 缺黑色圆角底板`);
    assert.ok(link.includes(K_D) && link.includes(DOT_D.slice(0, 40)) && link.includes("%231783FF"), `${p} 的 favicon 不是官方 Logomark`);
  }
});
