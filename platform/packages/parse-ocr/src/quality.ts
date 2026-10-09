/**
 * 页质量判定（方案 §8.1：低质量页可见、可重扫、可人工纠正——不伪造文本）。
 * 文本页按字符数；扫描页/图片按 OCR 置信度：meanScore < 0.6 或空文本 → low；
 * OCR 失败/模型未就绪 → unreadable（报告注明「本机 OCR 未就绪」）。
 */
export interface PageQuality {
  pageNo: number;
  kind: "text" | "scanned" | "image";
  quality: "ok" | "low" | "unreadable";
  note?: string | undefined;
}

export const OCR_LOW_SCORE = 0.6;

export function textPageQuality(pageNo: number, charCount: number, kind: "text" | "scanned" | "image" = "text"): PageQuality {
  if (charCount < 20) return { pageNo, kind, quality: "low", note: `文本层仅 ${charCount} 字符` };
  return { pageNo, kind, quality: "ok" };
}

export function ocrPageQuality(pageNo: number, kind: "scanned" | "image", ocr: { text: string; meanScore: number }): PageQuality {
  if (ocr.text.trim().length === 0) return { pageNo, kind, quality: "low", note: "OCR 空文本（可能为空白页、印章页或识别失败）" };
  if (ocr.meanScore < OCR_LOW_SCORE) return { pageNo, kind, quality: "low", note: `OCR 置信度均值 ${ocr.meanScore.toFixed(2)} 低于 ${OCR_LOW_SCORE}，建议重扫或人工纠正` };
  return { pageNo, kind, quality: "ok" };
}

export function unreadablePage(pageNo: number, kind: "scanned" | "image", note: string): PageQuality {
  return { pageNo, kind, quality: "unreadable", note };
}
