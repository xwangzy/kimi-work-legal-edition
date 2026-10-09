/**
 * 生成新 DOCX（意见书/报告/清洁稿模板）：最小合法包，Word/WPS 可开。
 */
import { writeZip } from "./zip.ts";
import { escapeXml } from "./textmap.ts";

export interface ReportSection {
  heading: string;
  paragraphs: string[];
}

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cp2="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>Kimi Work 法律行业发行版（AI 辅助起草，经律师复核）</dc:creator>
<cp:lastModifiedBy></cp:lastModifiedBy>
</cp:coreProperties>`;

function paraXml(text: string, bold: boolean): string {
  const rpr = bold ? "<w:rPr><w:b/></w:rPr>" : "";
  return `<w:p><w:r>${rpr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

export function createDocx(title: string, sections: ReportSection[]): Buffer {
  const body: string[] = [paraXml(title, true)];
  for (const s of sections) {
    body.push(paraXml(s.heading, true));
    for (const p of s.paragraphs) body.push(paraXml(p, false));
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr/></w:body></w:document>`;
  return writeZip([
    { name: "[Content_Types].xml", data: Buffer.from(CT, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(RELS, "utf8") },
    { name: "docProps/core.xml", data: Buffer.from(CORE, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
  ]);
}

/** 纯文本 → DOCX（清洁稿从文本重建的降级路径；主路径是修订稿接受全部修订）。 */
export function textToDocx(text: string): Buffer {
  return createDocx("", [{ heading: "", paragraphs: text.split(/\n+/) }]);
}
