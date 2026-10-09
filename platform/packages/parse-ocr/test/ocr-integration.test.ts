/**
 * 真实模型集成测试（方案 §8.1；门控：content/ocr-models 模型存在才执行，缺失则跳过并打印提示）。
 * 用 @napi-rs/canvas + 系统中文字体渲染文字为图片，走 PP-OCRv5 mobile 真实识别：
 * 断言关键子串命中率（阈值放宽，合成图片与真实扫描有差异）；扫描 PDF 走完整解析进程路径。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { PpuOcrEngine, ocrModelsAvailable, type OcrModelPaths } from "../src/ocr-engine.ts";
import { runParseBatch } from "../src/worker-client.ts";
import { makeImagePdf } from "../src/testing-pdf.ts";

const modelDir = fileURLToPath(new URL("../../../content/ocr-models", import.meta.url));
const modelPaths: OcrModelPaths = {
  det: join(modelDir, "ch_PP-OCRv5_det_mobile.onnx"),
  rec: join(modelDir, "ch_PP-OCRv5_rec_mobile.onnx"),
  dict: join(modelDir, "ppocrv5_dict.txt"),
};
const HAS_MODELS = ocrModelsAvailable(modelPaths);

const FONT_CANDIDATES = [
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "/System/Library/Fonts/STHeiti Medium.ttc",
  "/System/Library/Fonts/Supplemental/Songti.ttc",
];

/** 期望文本的字符命中率（宽松阈值：合成渲染与真实扫描有差异，避免字体环境造成假失败）。 */
function hitRate(expected: string, actual: string): number {
  const chars = [...expected].filter((c) => c.trim());
  const hit = chars.filter((c) => actual.includes(c)).length;
  return chars.length === 0 ? 0 : hit / chars.length;
}

function renderTextPng(lines: string[]): Buffer {
  const fontPath = FONT_CANDIDATES.find((p) => existsSync(p));
  if (fontPath) GlobalFonts.registerFromPath(fontPath, "OcrTest");
  const c = createCanvas(1600, 120 * lines.length + 80);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#000";
  ctx.font = `44px "OcrTest"`;
  lines.forEach((line, i) => ctx.fillText(line, 60, 100 + i * 120));
  return c.toBuffer("image/png");
}

let engine: PpuOcrEngine;

before(() => {
  if (!HAS_MODELS) {
    console.warn("[ocr-integration] 模型缺失，跳过真实模型测试（先运行 npm run fetch-ocr-models）→", modelDir);
    return;
  }
  engine = new PpuOcrEngine(modelPaths);
});

test("真实模型：中文文字图片识别（命中率 ≥ 60%）", { timeout: 180_000, skip: !HAS_MODELS && "模型缺失（npm run fetch:ocr-models）" }, async () => {
  const expected = "乙方应当遵守保密义务不得泄露甲方商业秘密";
  const png = renderTextPng([expected]);
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height);
  const r = await engine.recognize({ width: img.width, height: img.height, data: new Uint8Array(data.data.buffer.slice(0)) });
  const rate = hitRate(expected, r.text);
  console.log(`[ocr-integration] 识别结果: ${r.text}（命中率 ${(rate * 100).toFixed(0)}%，置信度 ${r.meanScore.toFixed(2)}）`);
  assert.ok(rate >= 0.6, `命中率 ${(rate * 100).toFixed(0)}% 低于 60%：${r.text}`);
  assert.ok(r.meanScore > 0.5, `置信度均值 ${r.meanScore} 过低`);
});

test("真实模型：扫描 PDF 走完整解析进程（单页）", { timeout: 180_000, skip: !HAS_MODELS && "模型缺失（npm run fetch:ocr-models）" }, async () => {
  const expected = "第七条保密义务";
  const png = renderTextPng([expected]);
  // PNG → RGB 位图 → 扫描 PDF
  const img = await loadImage(png);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height);
  const rgb = Buffer.alloc(img.width * img.height * 3);
  for (let i = 0; i < img.width * img.height; i++) {
    rgb[i * 3] = data.data[i * 4]!;
    rgb[i * 3 + 1] = data.data[i * 4 + 1]!;
    rgb[i * 3 + 2] = data.data[i * 4 + 2]!;
  }
  const pdf = makeImagePdf([{ width: img.width, height: img.height, rgb }]);
  const r = await runParseBatch({ file: pdf, kind: "pdf", modelPaths, pageTimeoutMs: 120_000 });
  assert.equal(r.pageCount, 1);
  const page = r.pages[0]!;
  const rate = hitRate(expected, page.text);
  console.log(`[ocr-integration] 扫描页识别: ${page.text}（命中率 ${(rate * 100).toFixed(0)}%，峰值 rss ${(r.peakRss / 1048576).toFixed(0)}MB）`);
  assert.equal(page.kind, "scanned");
  assert.ok(rate >= 0.6, `命中率 ${(rate * 100).toFixed(0)}% 低于 60%：${page.text}`);
  assert.ok(r.peakRss > 0);
});
