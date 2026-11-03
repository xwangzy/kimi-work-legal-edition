/**
 * PDF 文本层抽取（方案 v5.0 第 4 篇 §8.1：pdfjs-dist legacy build 在 Node 中用
 * getTextContent 抽取，无需 canvas）。扫描页判定：文本层字符数低于阈值（默认 20）。
 * 防护（如实注释）：页数 > 500 或单页尺寸异常（> 10000pt 任一边，防畸形/炸弹 PDF
 * 拖垮渲染与内存）→ DomainError('parse_unsafe')，不硬撑解析。
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { DomainError } from "@zr-legal/domain";

export interface PdfTextPage {
  pageNo: number; // 1 起
  text: string;
  charCount: number;
}

export interface PdfTextOutcome {
  pages: PdfTextPage[];
  pageCount: number;
}

export const SCAN_TEXT_THRESHOLD = 20;
export const MAX_PDF_PAGES = 500;
const MAX_PAGE_SIDE_PT = 10_000;

/**
 * 康熙部首与部首补充字符折回统一汉字（V10 第 36 批）：macOS 导出的 PDF（Word for Mac、Pages
 * 经 Quartz）里，宋体、苹方等字体的同一字形同时对应部首与汉字，文本层常写成部首码位——
 * “甲⽅”“⼄⽅”“《中华⼈民共和国民法典》”看着一样，法名、条文核验、材料检索与姓名识别都对不上。
 * 只折这两个区段（逐字 NFKC；补充区里没有兼容分解的字保持原样），全角标点不动，字数与位置不变。
 */
const CJK_RADICAL_RE = /[⺀-⻳⼀-⿕]/g;
export function foldCjkRadicals(s: string): string {
  return s.replace(CJK_RADICAL_RE, (c) => {
    const n = c.normalize("NFKC");
    return n.length === 1 ? n : c;
  });
}

export async function extractPdfText(buf: Buffer): Promise<PdfTextOutcome> {
  const data = new Uint8Array(buf);
  const loadingTask = getDocument({ data, useSystemFonts: false });
  const doc = await loadingTask.promise;
  try {
    const pageCount = doc.numPages;
    if (pageCount > MAX_PDF_PAGES) {
      throw new DomainError("parse_unsafe", `PDF 页数 ${pageCount} 超出安全上限 ${MAX_PDF_PAGES}（防畸形/炸弹文件），已拒绝解析`, 422, { pages: pageCount });
    }
    const pages: PdfTextPage[] = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      if (vp.width > MAX_PAGE_SIDE_PT || vp.height > MAX_PAGE_SIDE_PT) {
        throw new DomainError("parse_unsafe", `PDF 第 ${i} 页尺寸异常（${Math.round(vp.width)}×${Math.round(vp.height)}pt），已拒绝解析`, 422);
      }
      const content = await page.getTextContent();
      let text = "";
      let lastY: number | null = null;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = (item.transform as number[])[5] ?? 0;
        if (lastY !== null && Math.abs(y - lastY) > 2) text += "\n";
        text += item.str;
        lastY = y;
      }
      text = foldCjkRadicals(text).trim();
      pages.push({ pageNo: i, text, charCount: text.length });
    }
    return { pages, pageCount };
  } finally {
    await loadingTask.destroy();
  }
}

/** 扫描页判定：文本层字符低于阈值即按扫描件处理（走 OCR）。 */
export function isScannedPage(page: PdfTextPage, threshold: number = SCAN_TEXT_THRESHOLD): boolean {
  return page.charCount < threshold;
}
