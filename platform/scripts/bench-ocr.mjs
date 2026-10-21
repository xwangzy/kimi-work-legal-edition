/**
 * OCR 基准（探针 8 数据点；方案 §13：扫描件 OCR 每页目标 ≤2 秒、进程峰值内存 ≤1GB）：
 * 生成 20 页（BENCH_PAGES 可改）扫描件 PDF（合成文字图）→ 真实模型走隔离解析进程 → 记录总耗时/页均/峰值 rss。
 *
 * ⚠️ 口径如实标注：macOS arm64 开发机实测，**非 Windows i5 验收数据**（探针 8 的正式验收
 * 在 Windows 参考机上做）；合成文字图与真实扫描件难度不同，仅作量级参考。
 * 用法：node scripts/bench-ocr.mjs（须先 npm run fetch:ocr-models）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { runParseBatch, testingPdf } from "@zr-legal/parse-ocr";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const modelDir = join(root, "content", "ocr-models");
const modelPaths = {
  det: join(modelDir, "ch_PP-OCRv5_det_mobile.onnx"),
  rec: join(modelDir, "ch_PP-OCRv5_rec_mobile.onnx"),
  dict: join(modelDir, "ppocrv5_dict.txt"),
};
for (const p of Object.values(modelPaths)) {
  if (!existsSync(p)) throw new Error(`模型缺失：${p}（先运行 npm run fetch:ocr-models）`);
}

const PAGES = Number(process.env.BENCH_PAGES ?? 20);
const W = 1240;
const H = 1754;
const fontPath = ["/System/Library/Fonts/Hiragino Sans GB.ttc", "/System/Library/Fonts/STHeiti Medium.ttc"].find((p) => existsSync(p));
if (fontPath) GlobalFonts.registerFromPath(fontPath, "OcrBench");

function pageImage(i) {
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#000";
  ctx.font = '36px "OcrBench"';
  ctx.fillText(`股权转让协议（扫描页 ${i + 1}/${PAGES}）`, 60, 90);
  ctx.font = '30px "OcrBench"';
  const lines = [
    `${i + 1}.1 乙方应当遵守《律师法》规定的保密义务，不得泄露在履行本协议过程中知悉的甲方商业秘密。`,
    `${i + 1}.2 双方其他权利义务适用《民法典》第五百零九条之规定。`,
    `${i + 1}.3 本条约定的保密期限自本协议签订之日起至终止后三年届满为止。`,
  ];
  lines.forEach((l, k) => ctx.fillText(l, 60, 180 + k * 70));
  const data = ctx.getImageData(0, 0, W, H).data;
  const rgb = Buffer.alloc(W * H * 3);
  for (let p = 0; p < W * H; p++) {
    rgb[p * 3] = data[p * 4];
    rgb[p * 3 + 1] = data[p * 4 + 1];
    rgb[p * 3 + 2] = data[p * 4 + 2];
  }
  return { width: W, height: H, rgb };
}

console.log(`[bench-ocr] 生成 ${PAGES} 页扫描件 PDF…`);
const images = Array.from({ length: PAGES }, (_, i) => pageImage(i));
const pdf = testingPdf.makeImagePdf(images);
console.log(`[bench-ocr] PDF ${(pdf.length / 1048576).toFixed(1)} MB；开始解析（真实模型，隔离进程）`);

const t0 = Date.now();
const r = await runParseBatch({ file: pdf, kind: "pdf", modelPaths, pageTimeoutMs: 120_000 });
const totalMs = Date.now() - t0;
const hitPages = r.pages.filter((p) => p.text.includes("保密")).length;
const meanScore = r.pages.reduce((n, p) => n + (p.meanScore ?? 0), 0) / r.pages.length;

const result = {
  benchmark: `ocr-${PAGES}-pages-scanned-pdf`,
  caveat: "macOS arm64 开发机实测，非 Windows i5 验收数据（探针 8 正式验收在 Windows 参考机）；合成文字图仅作量级参考",
  machine: { platform: process.platform, arch: process.arch, node: process.version },
  pages: r.pageCount,
  total_ms: totalMs,
  per_page_ms_avg: Math.round(totalMs / r.pageCount),
  peak_rss_mb: Math.round(r.peakRss / 1048576),
  continuations: r.continuations,
  ocr_mean_score: Number(meanScore.toFixed(3)),
  pages_with_keyphrase: hitPages,
  targets: { per_page_ms: 2000, peak_rss_mb: 1024 },
  pass: { per_page: totalMs / r.pageCount <= 2000, rss: r.peakRss / 1048576 <= 1024 },
  at: new Date().toISOString(),
};
const outDir = join(root, "output");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `bench-ocr-${PAGES}p-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
console.log(`[bench-ocr] 已写入 ${outFile}`);
