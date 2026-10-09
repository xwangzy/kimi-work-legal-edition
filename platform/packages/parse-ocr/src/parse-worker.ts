/**
 * 隔离解析进程入口（方案 §8.1/§4.2：压缩包在解析进程中解包并做安全检查；单个 OCR 进程
 * 串行处理、页级流水——第三方实测批处理峰值内存约 1 GB，本进程每批一个、逐页报告 rss）。
 * 协议：stdin/stdout NDJSON——
 *   入：{id, t:"parse_pdf"|"parse_image", file: base64, modelPaths?: {det,rec,dict}|null, mockOcr?: boolean}
 *   出：{id, t:"page", pageNo, kind, text, quality, meanScore?, note?, rss} … {id, t:"done", pageCount, peakRss} | {id, t:"error", code, message}
 * 每页后报告 rss（父进程汇总峰值）；任何页异常不拖垮整批——该页按 unreadable 标记并继续（不伪造文本）。
 */
import { extractPdfText, isScannedPage } from "./pdf-text.ts";
import { openPdf, renderPdfPage } from "./pdf-render.ts";
import { decodeImage } from "./image-decode.ts";
import { MockOcrEngine, PpuOcrEngine, ocrModelsAvailable, type OcrEngine, type OcrModelPaths } from "./ocr-engine.ts";
import { ocrPageQuality, textPageQuality, unreadablePage, type PageQuality } from "./quality.ts";

interface ParseRequest {
  id: string;
  t: "parse_pdf" | "parse_image";
  file: string; // base64
  modelPaths?: OcrModelPaths | null;
  mockOcr?: boolean;
  /** 起始页（续跑用；配合 OCR 页预算回收机制）。 */
  startPage?: number;
  /** 单进程 OCR 页预算：超过即退出由父进程续跑（长文档内存闸门，§13 峰值内存控制）。 */
  ocrPageBudget?: number;
}

/** 默认 OCR 页预算：每进程最多渲染/OCR 的页数（实证 ~70MB/页 递增，见 bench；探针 8 在 Windows 参考机校准）。 */
export const DEFAULT_OCR_PAGE_BUDGET = 10;

interface PageQualityOut extends PageQuality {
  text: string;
  meanScore?: number | undefined;
  rss: number;
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function engineFor(req: ParseRequest): OcrEngine | null {
  if (req.mockOcr) return new MockOcrEngine([{ text: "模拟OCR文本（mock 引擎）", lines: [{ text: "模拟OCR文本（mock 引擎）", score: 0.99, box: [] }], meanScore: 0.99 }]);
  if (req.modelPaths && ocrModelsAvailable(req.modelPaths)) return new PpuOcrEngine(req.modelPaths);
  return null;
}

async function runOcr(engine: OcrEngine | null, bitmap: { width: number; height: number; data: Uint8Array }, pageNo: number, kind: "scanned" | "image"): Promise<PageQualityOut> {
  if (!engine) {
    const q = unreadablePage(pageNo, kind, "本机 OCR 未就绪（模型缺失——请运行 npm run fetch:ocr-models；不伪造文本）");
    return { ...q, text: "", rss: process.memoryUsage().rss };
  }
  try {
    const r = await engine.recognize(bitmap);
    const q = ocrPageQuality(pageNo, kind, r);
    return { ...q, text: r.text, meanScore: r.meanScore, rss: process.memoryUsage().rss };
  } catch (e) {
    const q = unreadablePage(pageNo, kind, `OCR 识别失败：${(e as Error)?.message ?? e}`.slice(0, 200));
    return { ...q, text: "", rss: process.memoryUsage().rss };
  }
}

async function parsePdf(req: ParseRequest, buf: Buffer, engine: OcrEngine | null): Promise<void> {
  const textOut = await extractPdfText(buf);
  const scanned = textOut.pages.filter((p) => isScannedPage(p));
  const startPage = req.startPage ?? 1;
  const budget = req.ocrPageBudget ?? DEFAULT_OCR_PAGE_BUDGET;
  let ocrDone = 0;
  let doc: Awaited<ReturnType<typeof openPdf>> | null = null;
  try {
    if (scanned.length > 0) doc = await openPdf(buf);
    for (const page of textOut.pages) {
      if (page.pageNo < startPage) continue; // 续跑：跳过已完成页
      if (!isScannedPage(page)) {
        const q = textPageQuality(page.pageNo, page.charCount);
        send({ id: req.id, t: "page", ...q, text: page.text, rss: process.memoryUsage().rss } satisfies PageQualityOut & { id: string; t: string });
      } else {
        // OCR 页预算：到预算即退出（发送 continue 由父进程以新进程续跑——每页 ~70MB 的
        // OpenCV/WASM 递增随之归还 OS，长文档峰值内存被预算封顶）
        if (ocrDone >= budget) {
          send({ id: req.id, t: "continue", nextPageNo: page.pageNo, peakRss: process.memoryUsage().rss });
          doc!.destroy();
          doc = null;
          process.exit(0);
        }
        const bitmap = await renderPdfPage(doc!, page.pageNo);
        const out = await runOcr(engine, bitmap, page.pageNo, "scanned");
        ocrDone += 1;
        send({ id: req.id, t: "page", ...out });
      }
    }
    send({ id: req.id, t: "done", pageCount: textOut.pageCount, peakRss: process.memoryUsage().rss });
  } finally {
    doc?.destroy();
  }
}

async function parseImage(req: ParseRequest, buf: Buffer, engine: OcrEngine | null): Promise<void> {
  const bitmap = await decodeImage(buf);
  const out = await runOcr(engine, bitmap, 1, "image");
  send({ id: req.id, t: "page", ...out });
  send({ id: req.id, t: "done", pageCount: 1, peakRss: process.memoryUsage().rss });
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let req: ParseRequest;
  try {
    req = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ParseRequest;
  } catch {
    send({ id: "?", t: "error", code: "validation", message: "请求不是合法 JSON" });
    process.exit(1);
  }
  const engine = engineFor(req);
  const buf = Buffer.from(req.file, "base64");
  try {
    if (req.t === "parse_pdf") await parsePdf(req, buf, engine);
    else await parseImage(req, buf, engine);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    send({ id: req.id, t: "error", code: err?.code ?? "internal", message: err?.message ?? String(e) });
  }
}

void main();
