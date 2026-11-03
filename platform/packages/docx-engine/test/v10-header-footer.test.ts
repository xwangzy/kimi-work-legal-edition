/**
 * V10 第 36 批：页眉页脚里的文字也能写原生修订（V9.6 真实走查 R5、V10 走查 V2：律师要求“全文（含页眉）”统一改正乙方名称）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applyRevisionsToDocx, createStyledDocx, headerFooterParagraphs, readZipEntries, sanitizeDocx, writeZip, extractParagraphs } from "../src/index.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hdr = (t: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p></w:hdr>`;
function doc(): Buffer {
  const base = createStyledDocx([{ kind: "p", runs: [{ text: "乙方：杭州数衍智能科技有限公司" }] }], undefined, null, { mark: false });
  const f = readZipEntries(base);
  f.set("word/header1.xml", Buffer.from(hdr("杭州数衍智能科技有限公司 · 技术开发合同"), "utf8"));
  f.set("word/header2.xml", Buffer.from(hdr("首页：杭州数衍智能科技有限公司"), "utf8"));
  return writeZip([...f].map(([name, data]) => ({ name, data })));
}
const op = (anchor: string, newText: string, part?: "header" | "footer") => ({ opId: "o1", anchor: { originalText: anchor, ...(part ? { part } : {}) }, originalHash: sha(anchor), newText, author: "测试", comment: "理由" });

test("页眉修改：每个含锚点的页眉部件各写一处原生修订，不挂批注；正文不动；清洁稿接受", () => {
  const src = doc();
  const r = applyRevisionsToDocx(src, { baselineHash: sha(src), ops: [op("杭州数衍智能科技有限公司", "杭州数衍智能技术有限公司", "header")] });
  assert.deepEqual(r.applied[0]!.partNames, ["word/header1.xml", "word/header2.xml"]);
  assert.equal(r.applied[0]!.paragraphIndex, -1);
  const z = readZipEntries(r.docx);
  for (const n of ["word/header1.xml", "word/header2.xml"]) {
    const x = z.get(n)!.toString("utf8");
    assert.match(x, /<w:delText xml:space="preserve">科技<\/w:delText>/);
    assert.match(x, /<w:ins\b[^>]*><w:r><w:t xml:space="preserve">技术<\/w:t>/);
    assert.ok(!/comment/.test(x), "页眉不挂批注");
  }
  assert.equal(z.get("word/document.xml")!.toString("utf8"), readZipEntries(src).get("word/document.xml")!.toString("utf8"), "正文字节不变");
  assert.equal(extractParagraphs(r.docx)[0]!.text, "乙方：杭州数衍智能科技有限公司");
  const clean = headerFooterParagraphs(sanitizeDocx(r.docx).docx).filter((x) => x.part === "header");
  assert.deepEqual(clean.map((x) => x.texts[0]), ["杭州数衍智能技术有限公司 · 技术开发合同", "首页：杭州数衍智能技术有限公司"]);
});

test("页眉里没有这段原文：整体停止（anchor_mismatch），不改任何部件；不带 part 的修改照旧只在正文里找", () => {
  const src = doc();
  assert.throws(() => applyRevisionsToDocx(src, { baselineHash: sha(src), ops: [op("不存在的公司", "x", "header")] }), /页眉里没有这段原文/);
  assert.throws(() => applyRevisionsToDocx(src, { baselineHash: sha(src), ops: [op("杭州数衍智能科技有限公司", "x", "footer")] }), /页脚里没有这段原文/);
  const body = applyRevisionsToDocx(src, { baselineHash: sha(src), ops: [op("杭州数衍智能科技有限公司", "杭州数衍智能技术有限公司")] });
  assert.equal(readZipEntries(body.docx).get("word/header1.xml")!.toString("utf8"), hdr("杭州数衍智能科技有限公司 · 技术开发合同"), "正文修改不碰页眉");
});
