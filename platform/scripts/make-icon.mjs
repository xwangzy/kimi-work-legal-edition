/**
 * 生成应用图标 apps/desktop/build/icon.png（512×512；electron-builder 由此生成 .ico）。
 * 与侧栏品牌标识一致：Kimi Work 强调色圆角方块 + 白色“K”，右下角法律版标记。
 * 用法：node scripts/make-icon.mjs
 */
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../apps/desktop/build/icon.png", import.meta.url));
const S = 512;
const c = createCanvas(S, S);
const g = c.getContext("2d");
const r = 112;
g.beginPath();
g.moveTo(r, 0);
g.arcTo(S, 0, S, S, r);
g.arcTo(S, S, 0, S, r);
g.arcTo(0, S, 0, 0, r);
g.arcTo(0, 0, S, 0, r);
g.closePath();
g.fillStyle = "#167ffb";
g.fill();
g.fillStyle = "#ffffff";
g.font = "bold 330px sans-serif";
g.textAlign = "center";
g.textBaseline = "middle";
g.fillText("K", S / 2 - 8, S / 2 + 14);
// 法律版标记：右下角天平点
g.beginPath();
g.arc(S - 118, S - 118, 54, 0, Math.PI * 2);
g.fillStyle = "#0b1f3a";
g.fill();
g.fillStyle = "#ffffff";
g.font = "bold 64px sans-serif";
g.fillText("法", S - 118, S - 114);
writeFileSync(out, c.toBuffer("image/png"));
console.log(`[make-icon] → ${out}`);
