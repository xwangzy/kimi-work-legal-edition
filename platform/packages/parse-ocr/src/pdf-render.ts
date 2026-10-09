/**
 * PDF 页渲染为位图（方案 §8.1：扫描件渲染成位图用 PDFium 的 WebAssembly 包，约 11 MB）。
 * scale=2 ≈ 144 DPI：OCR 中文正文（小五号及以上）在该分辨率下识别稳定，再高对 mobile 档
 * 模型收益递减而内存/耗时线性上升（bench 脚本可复测）；@hyzyla/pdfium 的 "BGRA" 枚举
 * 实证输出字节序即 R,G,B,A（见测试锁通道值），无需换序。
 */
import { PDFiumLibrary, type PDFiumDocument } from "@hyzyla/pdfium";
import { DomainError } from "@zr-legal/domain";

export interface RgbaBitmap {
  width: number;
  height: number;
  /** RGBA 顺序，4 字节/像素。 */
  data: Uint8Array;
}

let libPromise: Promise<PDFiumLibrary> | null = null;

function getLib(): Promise<PDFiumLibrary> {
  libPromise ??= PDFiumLibrary.init();
  return libPromise;
}

export async function openPdf(buf: Buffer): Promise<PDFiumDocument> {
  const lib = await getLib();
  return lib.loadDocument(new Uint8Array(buf));
}

export const RENDER_SCALE = 2;
/** 渲染输出长边上限（对齐 rec 的 maxCropSourceSideLength 默认 2000：更高分辨率对 mobile 档模型无收益，白耗内存）。 */
const MAX_RENDER_SIDE = 2000;

/**
 * 渲染指定页（1 起）为 RGBA 位图；调用方负责 document.destroy()。
 * 自适应 scale：min(scale, 上限/长边)——高分辨率扫描件不放大（控制位图内存，实证见 bench）。
 */
export async function renderPdfPage(doc: PDFiumDocument, pageNo: number, scale: number = RENDER_SCALE): Promise<RgbaBitmap> {
  const page = doc.getPage(pageNo - 1);
  const { originalWidth, originalHeight } = page.getOriginalSize();
  const longSide = Math.max(originalWidth, originalHeight);
  const effectiveScale = longSide > 0 ? Math.min(scale, MAX_RENDER_SIDE / longSide) : scale;
  const r = await page.render({ scale: effectiveScale, colorSpace: "BGRA" });
  const px = r.data;
  if (px.length !== r.width * r.height * 4) {
    throw new DomainError("parse_unsafe", `PDF 第 ${pageNo} 页渲染结果尺寸异常（${r.width}×${r.height}）`, 422);
  }
  // 实证：@hyzyla/pdfium 的 "BGRA" 枚举输出字节序即为 R,G,B,A（测试锁通道值），直接透传
  return { width: r.width, height: r.height, data: new Uint8Array(px.buffer.slice(px.byteOffset, px.byteOffset + px.byteLength)) };
}
