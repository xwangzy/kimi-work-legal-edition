/**
 * V14 第 39 批真实走查（T1 回稿重审，AI 卡）：对方把 4.1（三）项整段留痕删除，材料文字视图只显示可见文字，
 * 编号却按含删除段落计，助手看到“（二）……（四）……”，在会议要点里写“子项编号断档”——Word 接受修订后编号前移，并无断档。
 * 文字视图的编号按接受修订后的口径：整段删除的段落不占号。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, readZipEntries, writeZip } from "@zr-legal/docx-engine";
import { parseDocument } from "../src/services/parser.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const NUMBERING = `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="7"><w:multiLevelType w:val="multilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="（%2）"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num></w:numbering>`;
const P = (ilvl: number, body: string, mark = "") => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr>${mark ? `<w:rPr>${mark}</w:rPr>` : ""}</w:pPr>${body}</w:p>`;
const R = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const DEL = (t: string) => `<w:del w:id="1" w:author="对方律师" w:date="2026-10-30T07:20:00Z"><w:r><w:delText xml:space="preserve">${t}</w:delText></w:r></w:del>`;

test("整段留痕删除的子项不占编号：文字视图是（一）（二）（三），不是（一）（二）（四）", () => {
  const files = readZipEntries(createDocx("x", [{ heading: "x", paragraphs: ["y"] }], { mark: false }));
  const body = [P(0, R("先决条件")), P(1, R("股东会已批准；")), P(1, R("专利已转让；")), P(1, DEL("担保已解除；"), `<w:del w:id="2" w:author="对方律师" w:date="2026-10-30T07:20:00Z"/>`), P(1, R("核心人员已签约。"))].join("");
  files.set("word/document.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`));
  files.set("word/numbering.xml", Buffer.from(NUMBERING));
  const buf = writeZip([...files].map(([name, data]) => ({ name, data })));
  const text = parseDocument("回稿.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buf).text;
  assert.match(text, /（三） 核心人员已签约。/, text);
  assert.equal(text.includes("（四）"), false, text);
  assert.equal(text.includes("担保已解除"), false, "删除的文字不进可见文字");
});
