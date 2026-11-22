/**
 * 第 58 批（D-242）：本产品草稿里段后插入的样式。根因复盘：尽调报告修改轮把整句正文插在一级标题之后、沿用成一级标题；
 * 审合同意见书补的“问题35”标题插成了正文。
 * - insertAfterHeading：锚点是标题、又没指定样式的，新段落按正文；锚点是正文的照旧沿用锚点格式；
 * - insertStyles：指定了的，第一行用 first、其余用 rest，去掉锚点原样式的自动编号。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "@zr-legal/domain";
import { applyRevisionsToDocx, readZipEntries, writeZip, createDocx } from "../src/index.ts";

const para = (text: string, style: string, extra = "") => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${extra}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
function doc(): Buffer {
  const files = readZipEntries(createDocx("报告", [{ heading: "占位", paragraphs: ["占位"] }]));
  const body = [para("五、重大发现", "KwlHeading1", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>'), para("目标公司对外担保 800 万元。", "KwlBody"), para("问题34 付款条件", "KwlHeading2")].join("");
  files.set("word/document.xml", Buffer.from(files.get("word/document.xml")!.toString("utf8").replace(/<w:body>[\s\S]*?(<w:sectPr)/, `<w:body>${body}$1`)));
  return writeZip([...files.entries()].map(([name, data]) => ({ name, data })));
}
const HEADINGS = { headingStyles: ["KwlTitle", "KwlHeading1", "KwlHeading2", "KwlHeading3"], style: "KwlBody" };
const insert = (docx: Buffer, anchor: string, newText: string, extra: Record<string, unknown>) =>
  applyRevisionsToDocx(docx, { baselineHash: sha256Hex(docx), ops: [{ opId: "i", anchor: { originalText: anchor }, originalHash: sha256Hex(anchor), newText, insertAfter: true, author: "测试", ...extra }] }).docx;
const styles = (docx: Buffer) => {
  const xml = readZipEntries(docx).get("word/document.xml")!.toString("utf8");
  return [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)].map((m) => ({ style: /<w:pStyle w:val="([^"]+)"/.exec(m[1]!)?.[1] ?? "", num: /<w:numPr>/.test(m[1]!), text: [...m[1]!.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join("") })).filter((p) => p.text);
};

test("标题之后插一段、没指定样式：新段落是正文，不带标题的自动编号", () => {
  const out = styles(insert(doc(), "五、重大发现", "补充发现：2025 年度现金股利未按章程决议。", { insertAfterHeading: HEADINGS }));
  const p = out.find((x) => x.text.startsWith("补充发现"))!;
  assert.equal(p.style, "KwlBody");
  assert.equal(p.num, false);
});

test("正文之后插一段、没指定样式：照旧沿用锚点段落（正文）", () => {
  const out = styles(insert(doc(), "目标公司对外担保 800 万元。", "担保未经股东会决议。", { insertAfterHeading: HEADINGS }));
  assert.equal(out.find((x) => x.text.startsWith("担保未经"))!.style, "KwlBody");
});

test("指定 heading2：第一行二级标题、其余正文", () => {
  const out = styles(insert(doc(), "目标公司对外担保 800 万元。", "问题35 价格表差额\n价格表合计与正文差 180,000 元。", { insertStyles: { first: "KwlHeading2", rest: "KwlBody" }, insertAfterHeading: HEADINGS }));
  assert.equal(out.find((x) => x.text.startsWith("问题35"))!.style, "KwlHeading2");
  assert.equal(out.find((x) => x.text.startsWith("价格表合计"))!.style, "KwlBody");
});

test("不传这两项（律师上传的原件走 docx.revise）：照旧沿用锚点格式", () => {
  const out = styles(insert(doc(), "五、重大发现", "（插入）", {}));
  assert.equal(out.find((x) => x.text === "（插入）")!.style, "KwlHeading1");
});

// 第 58 批（D-249）：首页标题不印成文件名
import { documentHeading } from "../src/create.ts";
test("首页标题：文件名式标题去掉日期与事项简称；汇报类写成“类型（事项简称）”，正式文书只印类型", () => {
  assert.equal(documentHeading("案件进展汇报-鸿岫案-2026-11-09"), "案件进展汇报（鸿岫案）");
  assert.equal(documentHeading("民事起诉状-锐川诉禾丰"), "民事起诉状");
  assert.equal(documentHeading("提交前核对清单-锐川诉禾丰"), "提交前核对清单（锐川诉禾丰）");
  assert.equal(documentHeading("解除通知"), "解除通知");
  assert.equal(documentHeading("专利权转让协议"), "专利权转让协议");
  assert.equal(documentHeading("关于棣升公司保证责任的法律意见书"), "关于棣升公司保证责任的法律意见书");
  assert.equal(documentHeading("计算明细-锐川诉禾丰设备款-截至2026-11-30"), "计算明细");
  assert.equal(documentHeading("Q3-报告"), "Q3-报告", "首段不是中文的原样");
});

// 第 58 批：一页纸汇报的紧凑版式
import { createDocx as createDocxB58 } from "../src/create.ts";
test("一页纸版式：正文宋体五号（21 半磅）、单倍行距；缺省仍是小四", () => {
  const styles = (d: Buffer) => readZipEntries(d).get("word/styles.xml")!.toString("utf8");
  const compact = styles(createDocxB58("案件进展汇报-鸿岫案", [{ heading: "一、现状", paragraphs: ["一句话现状。"] }], { compact: true }));
  assert.match(compact, /<w:sz w:val="21"\/>/);
  assert.match(compact, /w:line="264"/);
  const normal = styles(createDocxB58("案件进展汇报-鸿岫案", [{ heading: "一、现状", paragraphs: ["一句话现状。"] }]));
  assert.match(normal, /<w:sz w:val="24"\/>/);
});
