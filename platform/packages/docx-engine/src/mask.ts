/**
 * 文本遮盖手术（脱敏/化名）：在 document.xml 内按段落文本定位并替换为遮盖值。
 * 与修订写入的区别：不留修订标记（脱敏件/化名件不得通过修订痕迹泄露原文）。
 * 未找到的遮盖目标：如实计入 notFound，不静默跳过。
 */
import { dropHouseMark } from "./house-style.ts";
import { DomainError } from "@zr-legal/domain";
import { readZipEntries, writeZip } from "./zip.ts";
import { escapeXml, mapParagraph, mapParagraphs, splitParagraphRuns } from "./textmap.ts";

export interface TextMask {
  /** 精确原文（在段落文本内定位） */
  find: string;
  /** 替换为（遮盖值/代号） */
  replace: string;
  /** 最多替换次数（默认全部） */
  maxOccurrences?: number;
}

export interface MaskResult {
  docx: Buffer;
  replaced: number;
  notFound: string[];
}

/** 遮盖要处理的部件：正文、页眉、页脚、脚注、尾注（V14 第 39 批：原先只处理正文，页脚里的“钱予墨 13823519076”原样留在对外脱敏件里）。 */
const MASK_PARTS = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

/** 各部件的可见文字（正文在前，页眉页脚等按部件名顺序），供脱敏前扫描标识符。 */
export function docxAllPartsText(docx: Buffer): string {
  const files = readZipEntries(docx);
  const names = [...files.keys()].filter((n) => MASK_PARTS.test(n)).sort((a, b) => (a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a.localeCompare(b)));
  return names.map((n) => mapParagraphs(files.get(n)!.toString("utf8")).map((p) => p.text).join("\n")).join("\n");
}

function maskXml(xml0: string, masks: TextMask[], found: Set<number>): { xml: string; replaced: number } {
  let xml = xml0;
  let replaced = 0;
  masks.forEach((mask, mi) => {
    if (!mask.find) return;
    let remaining = mask.maxOccurrences ?? Number.POSITIVE_INFINITY;
    for (;;) {
      if (remaining <= 0) break;
      const paras = mapParagraphs(xml);
      let applied = false;
      for (const hit of paras) {
        const idx = hit.text.indexOf(mask.find);
        if (idx < 0) continue;
        // 一个 run 里有几段文字、制表符的先拆开（第 34 批 D07：原先整 run 切除后只重发第一段文字，后半段会丢）
        const lenBefore = xml.length;
        xml = splitParagraphRuns(xml, hit);
        const para = mapParagraph(xml.slice(hit.xmlStart, hit.xmlEnd + xml.length - lenBefore), hit.xmlStart, hit.index);
        const spanStart = idx;
        const spanEnd = idx + mask.find.length;
        const coverSegs = para.segments.filter((s) => !s.deleted && s.end > spanStart && s.start < spanEnd);
        // 跨制表符、换行的不替换（只替换文字）
        if (coverSegs.length === 0 || coverSegs.some((s) => s.kind !== undefined && s.kind !== "text")) continue;
        const first = coverSegs[0]!;
        const last = coverSegs.at(-1)!;
        const rpr = first.rPr ?? "";
        const prefixText = first.text.slice(0, spanStart - first.start);
        const suffixText = last.text.slice(spanEnd - last.start);
        const parts: string[] = [];
        if (prefixText) parts.push(`<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(prefixText)}</w:t></w:r>`);
        parts.push(`<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(mask.replace)}</w:t></w:r>`);
        if (suffixText) parts.push(`<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(suffixText)}</w:t></w:r>`);
        const relStart = first.runXmlStart - para.xmlStart;
        const relEnd = last.runXmlEnd - para.xmlStart;
        const paraXml = xml.slice(para.xmlStart, para.xmlEnd);
        xml = xml.slice(0, para.xmlStart) + paraXml.slice(0, relStart) + parts.join("") + paraXml.slice(relEnd) + xml.slice(para.xmlEnd);
        applied = true;
        found.add(mi);
        replaced++;
        remaining--;
        break; // 段落映射已失效，重扫
      }
      if (!applied) break;
    }
  });
  return { xml, replaced };
}

export function maskDocxText(docx: Buffer, masks: TextMask[]): MaskResult {
  const files = readZipEntries(docx);
  if (!files.has("word/document.xml")) throw new DomainError("unsupported_file", "DOCX 缺少 word/document.xml", 422);
  let replaced = 0;
  const found = new Set<number>();
  for (const [name, data] of files) {
    if (!MASK_PARTS.test(name)) continue;
    const r = maskXml(data.toString("utf8"), masks, found);
    if (r.replaced > 0) files.set(name, Buffer.from(r.xml, "utf8"));
    replaced += r.replaced;
  }
  const notFound = masks.filter((m, i) => m.find && !found.has(i)).map((m) => m.find.slice(0, 40));
  dropHouseMark(files);
  return { docx: writeZip([...files.entries()].map(([name, data]) => ({ name, data }))), replaced, notFound };
}
