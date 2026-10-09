/**
 * 文本遮盖手术（脱敏/化名）：在 document.xml 内按段落文本定位并替换为遮盖值。
 * 与修订写入的区别：不留修订标记（脱敏件/化名件不得通过修订痕迹泄露原文）。
 * 未找到的遮盖目标：如实计入 notFound，不静默跳过。
 */
import { DomainError } from "@zr-legal/domain";
import { readZipEntries, writeZip } from "./zip.ts";
import { escapeXml, mapParagraphs } from "./textmap.ts";

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

export function maskDocxText(docx: Buffer, masks: TextMask[]): MaskResult {
  const files = readZipEntries(docx);
  let xml = files.get("word/document.xml")?.toString("utf8");
  if (xml === undefined) throw new DomainError("unsupported_file", "DOCX 缺少 word/document.xml", 422);

  let replaced = 0;
  const notFound: string[] = [];
  for (const mask of masks) {
    if (!mask.find) continue;
    let remaining = mask.maxOccurrences ?? Number.POSITIVE_INFINITY;
    let foundAny = false;
    for (;;) {
      if (remaining <= 0) break;
      const paras = mapParagraphs(xml);
      let applied = false;
      for (const para of paras) {
        const idx = para.text.indexOf(mask.find);
        if (idx < 0) continue;
        const spanStart = idx;
        const spanEnd = idx + mask.find.length;
        const coverSegs = para.segments.filter((s) => !s.deleted && s.end > spanStart && s.start < spanEnd);
        if (coverSegs.length === 0) continue;
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
        foundAny = true;
        replaced++;
        remaining--;
        break; // 段落映射已失效，重扫
      }
      if (!applied) break;
    }
    if (!foundAny) notFound.push(mask.find.slice(0, 40));
  }
  files.set("word/document.xml", Buffer.from(xml, "utf8"));
  return { docx: writeZip([...files.entries()].map(([name, data]) => ({ name, data }))), replaced, notFound };
}
