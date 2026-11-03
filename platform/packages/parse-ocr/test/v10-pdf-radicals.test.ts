/**
 * V10 第 36 批：macOS 导出的 PDF 文本层写成康熙部首码位（“甲⽅”“⼄⽅”“中华⼈民共和国”），
 * 抽取时折回统一汉字。夹具 mac-quartz-songti.pdf 由 macOS Quartz PDFContext 以宋体生成（虚构文字）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractPdfText, foldCjkRadicals } from "../src/pdf-text.ts";

const fixture = () => readFileSync(fileURLToPath(new URL("./fixtures/mac-quartz-songti.pdf", import.meta.url)));
const RADICALS = /[⺀-⻳⼀-⿕]/;

test("康熙部首折回统一汉字：全角标点不动、字数不变", () => {
  const src = "甲⽅（买⽅）与⼄⽅：《中华⼈民共和国民法典》⼀条";
  const out = foldCjkRadicals(src);
  assert.equal(out, "甲方（买方）与乙方：《中华人民共和国民法典》一条");
  assert.equal(out.length, src.length);
  // 部首补充区里没有兼容分解的字保持原样
  assert.equal(foldCjkRadicals("⺁"), "⺁");
  assert.equal(foldCjkRadicals("１２３，ＡＢ"), "１２３，ＡＢ");
});

test("macOS 宋体 PDF：原始文本层是部首码位，抽取结果是统一汉字", async () => {
  const task = getDocument({ data: new Uint8Array(fixture()), useSystemFonts: false });
  const doc = await task.promise;
  const raw = (await (await doc.getPage(1)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("");
  await task.destroy();
  assert.match(raw, RADICALS, "夹具应能复现部首码位，否则本用例失去意义");

  const out = await extractPdfText(fixture());
  const text = out.pages[0]!.text;
  assert.doesNotMatch(text, RADICALS);
  assert.match(text.replace(/\n/g, ""), /甲方（买方）与乙方（卖方）依据《中华人民共和国民法典》第一条/);
});
