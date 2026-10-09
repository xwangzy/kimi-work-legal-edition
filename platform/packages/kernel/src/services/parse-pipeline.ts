/**
 * 解析管线（方案 §8.1）：PDF 文本层 + 扫描页/图片 OCR（隔离进程，§4.5 与 Agent 互斥经调用方持锁）。
 * 输出：parse_texts 用文本（\f 换页分隔——锚点 file_page 由字符区间换算）+ 页级质量（parse_pages）。
 * 失败诚实：模型缺失时扫描/图片页标 unreadable 并注明「本机 OCR 未就绪」，不伪造文本；
 * 文本层路径不依赖模型，照常可用。
 */
import { runParseBatch, ocrModelsAvailable, type OcrModelPaths, type ParsedPage } from "@zr-legal/parse-ocr";
import { DomainError } from "@zr-legal/domain";

export interface RichParseDeps {
  ocrModelPaths: OcrModelPaths;
  /** 开发/测试：mock OCR 引擎（ZR_PARSE_OCR_MOCK=1；不加载模型）。 */
  mockOcr: boolean;
}

export interface RichParseOutcome {
  /** 以 \f（换页符）分隔的逐页文本。 */
  text: string;
  pageCount: number | null;
  qualityFlags: string[];
  parser: string;
  parserVersion: string;
  pages: { pageNo: number; kind: "text" | "scanned" | "image"; quality: "ok" | "low" | "unreadable"; note?: string | undefined; charCount: number; meanScore?: number | undefined }[];
}

const PIPELINE_VERSION = "v0.2.0-pdf-ocr";

export function isPdf(filename: string, mime: string): boolean {
  return filename.toLowerCase().endsWith(".pdf") || mime === "application/pdf";
}

export function isImage(filename: string, mime: string): boolean {
  const l = filename.toLowerCase();
  return l.endsWith(".jpg") || l.endsWith(".jpeg") || l.endsWith(".png") || mime === "image/jpeg" || mime === "image/png";
}

export function ocrReady(deps: RichParseDeps): boolean {
  return deps.mockOcr || ocrModelsAvailable(deps.ocrModelPaths);
}

export async function parseWithPipeline(buf: Buffer, filename: string, mime: string, deps: RichParseDeps): Promise<RichParseOutcome> {
  const kind = isPdf(filename, mime) ? "pdf" : isImage(filename, mime) ? "image" : null;
  if (!kind) {
    throw new DomainError("unsupported_file", `parseWithPipeline 只处理 PDF/JPG/PNG（收到 ${mime} ${filename}）`, 422);
  }
  const modelPaths = deps.mockOcr ? null : deps.ocrModelPaths;
  const r = await runParseBatch({ file: buf, kind, modelPaths, mockOcr: deps.mockOcr });
  const flags = new Set<string>([kind === "pdf" ? "pdf_pipeline" : "image_ocr"]);
  let low = 0;
  let unreadable = 0;
  let scanned = 0;
  const pages = r.pages.map((p) => {
    if (p.kind !== "text") scanned += 1;
    if (p.quality === "low") low += 1;
    if (p.quality === "unreadable") unreadable += 1;
    return {
      pageNo: p.pageNo,
      kind: p.kind,
      quality: p.quality,
      note: p.note,
      charCount: p.text.length,
      meanScore: p.meanScore,
    };
  });
  if (scanned > 0) flags.add(`scanned_pages:${scanned}`);
  if (low > 0) flags.add(`ocr_low_quality_pages:${low}`);
  if (unreadable > 0) flags.add(`unreadable_pages:${unreadable}`);
  if (deps.mockOcr) flags.add("ocr_mock_engine");
  if (!ocrReady(deps) && scanned > 0) flags.add("ocr_unavailable");
  return {
    text: r.pages.map((p) => p.text).join("\f"),
    pageCount: r.pageCount,
    qualityFlags: [...flags],
    parser: kind === "pdf" ? "pdf-text+ocr" : "image-ocr",
    parserVersion: PIPELINE_VERSION,
    pages,
  };
}
