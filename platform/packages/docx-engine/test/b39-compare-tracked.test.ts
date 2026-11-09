/**
 * V14 第 39 批：整稿比对对“已标修订 / 静默”的判断。
 * 真实走查（T1 回稿比对，本机与 AI 两张卡）：对方把 4.1（三）项整段留痕删除（文字与段落标记都在 w:del 里），
 * 比对却报“静默删除”，静默数 7（应为 6），AI 卡据此在会议要点里加粗写“被静默删除”。
 * 根因：段落只按可见文字取，整段删除的段落可见文字为空被滤掉，删除一律当静默。
 * 这里用手工构造的回稿覆盖：整段留痕删除、整段留痕插入、未开修订直接改字、同一段里一处标了修订一处没标、页眉改动；
 * 另核对自动编号条款号（“4.1（三）”）与新增段落的位置。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareDocx, createDocx, readZipEntries, writeZip } from "../src/index.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const NUMBERING = `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}>
<w:abstractNum w:abstractNumId="7"><w:multiLevelType w:val="multilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="第%1条"/></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:isLgl/><w:lvlText w:val="%1.%2"/></w:lvl>
<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="（%3）"/></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num>
</w:numbering>`;
const num = (ilvl: number) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr>`;
const R = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const INS = (t: string, id: number) => `<w:ins w:id="${id}" w:author="对方律师" w:date="2026-10-30T07:20:00Z">${R(t)}</w:ins>`;
const DEL = (t: string, id: number) => `<w:del w:id="${id}" w:author="对方律师" w:date="2026-10-30T07:20:00Z"><w:r><w:delText xml:space="preserve">${t}</w:delText></w:r></w:del>`;
const P = (ilvl: number | null, body: string, markRev = "") =>
  `<w:p><w:pPr>${ilvl === null ? "" : num(ilvl)}${markRev ? `<w:rPr>${markRev}</w:rPr>` : ""}</w:pPr>${body}</w:p>`;

function docx(body: string, header: string): Buffer {
  const files = readZipEntries(createDocx("增资协议", [{ heading: "x", paragraphs: ["y"] }], { mark: false }));
  files.set("word/document.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`));
  files.set("word/numbering.xml", Buffer.from(NUMBERING));
  files.set("word/header1.xml", Buffer.from(`<w:hdr ${W}>${P(null, R(header))}</w:hdr>`));
  return writeZip([...files].map(([name, data]) => ({ name, data })));
}

const BASE = docx(
  [
    P(0, R("先决条件")),
    P(1, R("投资方支付第一期增资款以下列条件全部满足为前提：")),
    P(2, R("股东会已批准本次增资；")),
    P(2, R("专利已转让至公司名下；")),
    P(2, R("公司为澄岳电子提供的全部担保已解除，占用资金已全部归还；")),
    P(2, R("核心人员已签署劳动合同；")),
    P(1, R("重大不利变化指公司收入下降超过10%。")),
    P(1, R("回购价格按年利率8%计算。")),
    P(1, R("本协议适用中国法律。")),
  ].join(""),
  "投资方稿v1",
);

const DELETED_MARK = `<w:del w:id="2" w:author="对方律师" w:date="2026-10-30T07:20:00Z"/>`;
const INSERTED_MARK = `<w:ins w:id="5" w:author="对方律师" w:date="2026-10-30T07:20:00Z"/>`;
const CURRENT = docx(
  [
    P(0, R("先决条件")),
    P(1, R("投资方支付第一期增资款以下列条件全部满足为前提：")),
    P(2, R("股东会已批准本次增资；")),
    P(2, R("专利已转让至公司名下；")),
    // 整段留痕删除（文字与段落标记都删）
    P(2, DEL("公司为澄岳电子提供的全部担保已解除，占用资金已全部归还；", 1), DELETED_MARK),
    P(2, R("核心人员已签署劳动合同；")),
    // 静默改字：10% → 30%
    P(1, R("重大不利变化指公司收入下降超过30%。")),
    // 同一段：利率标了修订，“据丙方所知”没标
    P(1, R("据丙方所知，回购价格按年利率") + DEL("8%", 3) + INS("6%", 4) + R("计算。")),
    // 整段留痕插入
    P(1, INS("公司应在交割日起6个月内解除上述担保。", 6), INSERTED_MARK),
    P(1, R("本协议适用中国法律。")),
  ].join(""),
  "目标公司修改稿v2",
);

test("整段留痕删除算“已标修订”，不再报成静默删除；条款号带上一级编号", () => {
  const r = compareDocx(BASE, CURRENT);
  const del = r.changes.find((c) => c.type === "deleted");
  assert.ok(del, JSON.stringify(r.changes));
  assert.match(del.baseText, /澄岳电子/);
  assert.equal(del.silent, false, "文字与段落标记都在 w:del 里的删除是留痕删除");
  assert.equal(del.baseClause, "1.1（三）", "子项编号前接上一级编号");
});

test("未开修订直接改字是静默；一段里有一处没标修订也算静默；整段留痕插入不是静默", () => {
  const r = compareDocx(BASE, CURRENT);
  const byText = (s: string) => r.changes.find((c) => c.curText.includes(s) || c.baseText.includes(s));
  const mac = byText("30%")!;
  assert.equal(mac.type, "modified");
  assert.equal(mac.silent, true);
  assert.equal(mac.curClause, "1.2");
  const buyback = byText("6%")!;
  assert.equal(buyback.type, "modified");
  assert.equal(buyback.silent, true, "利率改动标了修订，但“据丙方所知，”是直接加的：拒绝修订回不到旧稿原文");
  const added = byText("6个月内解除")!;
  assert.equal(added.type, "added");
  assert.equal(added.silent, false, "整段在插入修订里");
  assert.equal(added.afterBaseIndex, 7, "插在旧稿第 8 个非空段（回购价格）之后");
  assert.equal(r.stats.silent, 2, JSON.stringify(r.changes.map((c) => [c.type, c.silent, c.baseText || c.curText])));
});

test("回购利率只标修订、没有别的改动时不算静默（拒绝修订后回到旧稿原文）", () => {
  const cur = docx(
    [
      P(0, R("先决条件")),
      P(1, R("回购价格按年利率") + DEL("8%", 3) + INS("6%", 4) + R("计算。")),
    ].join(""),
    "投资方稿v1",
  );
  const base = docx([P(0, R("先决条件")), P(1, R("回购价格按年利率8%计算。"))].join(""), "投资方稿v1");
  const r = compareDocx(base, cur);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0]!.silent, false);
  assert.deepEqual(r.headerFooter, [], "页眉没变");
});

test("页眉文字的变化单列，未标修订的报静默", () => {
  const r = compareDocx(BASE, CURRENT);
  assert.equal(r.headerFooter.length, 1);
  assert.equal(r.headerFooter[0]!.part, "页眉");
  assert.equal(r.headerFooter[0]!.baseText, "投资方稿v1");
  assert.equal(r.headerFooter[0]!.curText, "目标公司修改稿v2");
  assert.equal(r.headerFooter[0]!.silent, true);
});

test("条款号按接受修订后的口径：整段留痕删除的子项不占号，后面一项前移（Word 接受修订后的显示），不出现“（二）后接（四）”", async () => {
  const { extractParagraphs, acceptedNumberingXml, paragraphListLabels, readZipText } = await import("../src/index.ts");
  const paras = extractParagraphs(CURRENT);
  const after = paras.find((p) => p.text === "核心人员已签署劳动合同；");
  assert.equal(after?.clause, "1.1（三）", JSON.stringify(paras.map((p) => [p.clause, p.text.slice(0, 8)])));
  // 原样（含删除段落）计号时是（四）：只在计算编号时排除删除段落，原文 XML 不变
  const xml = readZipText(CURRENT, "word/document.xml")!;
  const raw = paragraphListLabels(xml, NUMBERING, null);
  assert.ok(raw.includes("（四）"));
  assert.equal(acceptedNumberingXml(xml).length > 0, true);
  assert.equal(paragraphListLabels(acceptedNumberingXml(xml), NUMBERING, null).filter(Boolean).length, raw.filter(Boolean).length - 1, "只少了被删除的那一项");
});
