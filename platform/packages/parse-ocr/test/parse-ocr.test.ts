/**
 * 解析与 OCR 单元测试（方案 §8.1）：文本层抽取与扫描页判定、页质量分级、PDF 防护、
 * 解析进程（mock 引擎整批/页超时杀进程/崩毁重建）、BGRA→RGBA 渲染与图片解码。
 * 真实模型集成测试见 ocr-integration.test.ts（模型门控）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPdfText, isScannedPage, MAX_PDF_PAGES } from "../src/pdf-text.ts";
import { makeTextPdf, makeImagePdf, type RawImage } from "../src/testing-pdf.ts";
import { ocrPageQuality, textPageQuality, unreadablePage } from "../src/quality.ts";
import { runParseBatch } from "../src/worker-client.ts";
import { decodeImage, rgbaToPng } from "../src/image-decode.ts";
import { openPdf, renderPdfPage } from "../src/pdf-render.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

function grayImage(w: number, h: number, v = 255): RawImage {
  return { width: w, height: h, rgb: Buffer.alloc(w * h * 3, v) };
}

test("PDF 文本层：逐页抽取与扫描页判定", async () => {
  const r = await extractPdfText(makeTextPdf(["Article 1 Contract Object", "Article 2 Payment Terms", "x"]));
  assert.equal(r.pageCount, 3);
  assert.match(r.pages[0]!.text, /Article 1/);
  assert.equal(isScannedPage(r.pages[0]!), false);
  assert.equal(isScannedPage(r.pages[2]!), true, "单字符页按扫描页处理");

  const img = await extractPdfText(makeImagePdf([grayImage(200, 100)]));
  assert.equal(img.pages.length, 1);
  assert.equal(isScannedPage(img.pages[0]!), true);
});

test("PDF 防护：页数超限拒绝（parse_unsafe）", async () => {
  const huge = makeTextPdf(Array.from({ length: MAX_PDF_PAGES + 1 }, (_, i) => `p${i}`));
  await assert.rejects(() => extractPdfText(huge), (e: any) => e.code === "parse_unsafe" && /上限/.test(e.message));
});

test("页质量分级：文本页/扫描页/unreadable", () => {
  assert.equal(textPageQuality(1, 100).quality, "ok");
  assert.equal(textPageQuality(1, 5).quality, "low");
  assert.equal(ocrPageQuality(2, "scanned", { text: "乙方应当遵守保密义务", meanScore: 0.92 }).quality, "ok");
  assert.equal(ocrPageQuality(2, "scanned", { text: "识别困难文本", meanScore: 0.41 }).quality, "low");
  assert.equal(ocrPageQuality(2, "scanned", { text: "", meanScore: 0 }).quality, "low");
  assert.equal(unreadablePage(3, "image", "本机 OCR 未就绪").quality, "unreadable");
});

test("渲染与解码：BGRA→RGBA 通道正确；PNG 往返", async () => {
  // 纯红像素图 → 渲染后 RGBA 首字节应为 R=200
  const rgb = Buffer.alloc(120 * 80 * 3);
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = 200;
    rgb[i + 1] = 10;
    rgb[i + 2] = 30;
  }
  const doc = await openPdf(makeImagePdf([{ width: 120, height: 80, rgb }]));
  const bm = await renderPdfPage(doc, 1, 1);
  doc.destroy();
  assert.equal(bm.width, 120);
  assert.equal(bm.height, 80);
  assert.equal(bm.data[0], 200, "R 通道");
  assert.equal(bm.data[1], 10, "G 通道");
  assert.equal(bm.data[2], 30, "B 通道");
  // RGBA → PNG → 解码往返
  const png = await rgbaToPng(bm);
  const back = await decodeImage(png);
  assert.equal(back.width, 120);
  assert.ok(Math.abs(back.data[0]! - 200) <= 2 && Math.abs(back.data[2]! - 30) <= 2);
});

test("解析进程：mock 引擎整批（文本页直通 + 扫描页 OCR + 模型缺失 unreadable）", async () => {
  const pdf = makeTextPdf(["Article 1 Contract Object"]);
  // 混合：一页文本 + 一页位图（扫描）
  const mixed = (() => {
    const t = makeTextPdf(["Article 1 Contract Object"]);
    const i = makeImagePdf([grayImage(200, 100)]);
    return { t, i };
  })();
  void mixed;

  // 全文本 PDF：文本页直通（不经 OCR）
  const r1 = await runParseBatch({ file: pdf, kind: "pdf", mockOcr: true });
  assert.equal(r1.pageCount, 1);
  assert.equal(r1.pages[0]!.kind, "text");
  assert.match(r1.pages[0]!.text, /Article 1/);

  // 扫描 PDF + mock 引擎 → OCR 文本与质量 ok
  const r2 = await runParseBatch({ file: makeImagePdf([grayImage(300, 200)]), kind: "pdf", mockOcr: true });
  assert.equal(r2.pages[0]!.kind, "scanned");
  assert.match(r2.pages[0]!.text, /模拟OCR文本/);
  assert.equal(r2.pages[0]!.quality, "ok");

  // 模型缺失（不给 modelPaths 且不 mock）→ unreadable 如实标记，不伪造文本
  const r3 = await runParseBatch({ file: makeImagePdf([grayImage(300, 200)]), kind: "pdf", modelPaths: null });
  assert.equal(r3.pages[0]!.quality, "unreadable");
  assert.equal(r3.pages[0]!.text, "");
  assert.match(r3.pages[0]!.note!, /OCR 未就绪/);

  // 图片批次
  const png = await rgbaToPng({ width: 4, height: 4, data: new Uint8Array(4 * 4 * 4).fill(255) });
  const r4 = await runParseBatch({ file: png, kind: "image", mockOcr: true });
  assert.equal(r4.pages[0]!.kind, "image");
  assert.equal(r4.pageCount, 1);
});

test("解析进程：页超时杀进程报错；崩毁自动重建并恢复", async () => {
  const pdf = makeTextPdf(["Article 1"]);
  await assert.rejects(
    () => runParseBatch({ file: pdf, kind: "pdf", mockOcr: true, pageTimeoutMs: 600, maxRestarts: 0, workerEntry: here("./fixtures/hang-worker.ts") }),
    (e: any) => /超时|异常/.test(e.message),
  );

  const dir = mkdtempSync(join(tmpdir(), "kwl-crash-"));
  const mark = join(dir, "once.mark");
  process.env.KWL_CRASH_MARK = mark;
  try {
    // 夹具变量经白名单显式透传（生产调用不传 extraEnvAllowlist）
    const r = await runParseBatch({ file: pdf, kind: "pdf", mockOcr: true, maxRestarts: 1, workerEntry: here("./fixtures/crash-once-worker.ts"), extraEnvAllowlist: ["KWL_CRASH_MARK"] });
    assert.equal(r.restarts, 1, "应重建一次");
    assert.match(r.pages[0]!.text, /重建后恢复文本/);
  } finally {
    delete process.env.KWL_CRASH_MARK;
  }
});

test("子进程 env 白名单：机密变量不可见、PATH 保留", async () => {
  process.env.ZR_MAAS_TOKEN = "test-secret-token";
  process.env.ZR_DB_KEY = "test-secret-dbkey";
  process.env.ZR_INTERNAL_SECRET = "test-secret-internal";
  try {
    const r = await runParseBatch({ file: makeTextPdf(["x"]), kind: "pdf", mockOcr: true, workerEntry: here("./fixtures/env-probe-worker.ts") });
    const env = (r.pages[0]! as any).env;
    assert.equal(env.ZR_MAAS_TOKEN, "undefined", "MAAS 令牌不得进入解析进程");
    assert.equal(env.ZR_DB_KEY, "undefined", "数据库密钥不得进入解析进程");
    assert.equal(env.ZR_INTERNAL_SECRET, "undefined", "内部密钥不得进入解析进程");
    assert.equal(env.PATH, "string", "PATH 保留（运行必需）");
  } finally {
    delete process.env.ZR_MAAS_TOKEN;
    delete process.env.ZR_DB_KEY;
    delete process.env.ZR_INTERNAL_SECRET;
  }
});

test("OCR 页预算续跑：budget=2 五页批 → 2 次 continue、页序完整、peakRss 聚合", async () => {
  const pdf = makeImagePdf([grayImage(300, 200), grayImage(300, 200), grayImage(300, 200), grayImage(300, 200), grayImage(300, 200)]);
  const r = await runParseBatch({ file: pdf, kind: "pdf", mockOcr: true, ocrPageBudget: 2 });
  assert.equal(r.continuations, 2, "5 页 / budget 2 → 2 次计划内续跑");
  assert.equal(r.pageCount, 5);
  assert.deepEqual(r.pages.map((p) => p.pageNo), [1, 2, 3, 4, 5], "全部页结果完整不乱序");
  for (const p of r.pages) assert.match(p.text, /模拟OCR文本/);
  // 聚合 peakRss = 各 incarnation 最大值（≥ 所有页采样 rss）
  const maxPageRss = Math.max(...r.pages.map((p) => p.rss));
  assert.ok(r.peakRss >= maxPageRss && r.peakRss > 0, `peakRss ${r.peakRss} 应不小于页采样最大值 ${maxPageRss}`);
});
