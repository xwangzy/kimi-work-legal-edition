/**
 * V10 第 36 批（V3 律师评分）：本产品生成的意见书经 docx.edit_draft 逐处修改后，版式标记丢失（下载 / 导出不再套函头），
 * 清洁稿还多出一个没登记的空 comments.xml。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applyRevisionsToDocx, createDocx, isHouseStyled, keepHouseMark, readZipEntries, sanitizeDocx } from "../src/index.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

test("草稿改字后保留版式标记；没有批注部件的不新建 comments.xml", () => {
  const draft = createDocx("关于某事项的法律意见书（草稿）", [{ heading: "一、结论", paragraphs: ["保证有效的可能性较大。"] }]);
  assert.equal(isHouseStyled(draft), true);
  assert.equal(readZipEntries(draft).has("word/comments.xml"), false);
  const a = "可能性较大";
  const edited = sanitizeDocx(applyRevisionsToDocx(draft, { baselineHash: sha(draft), ops: [{ opId: "o1", anchor: { originalText: a }, originalHash: sha(a), newText: "可能性较高", author: "t" }] }).docx).docx;
  assert.equal(readZipEntries(edited).has("word/comments.xml"), false, "不新建没登记的批注部件");
  assert.equal(isHouseStyled(edited), false, "修订引擎与清洁稿照旧去掉标记（律师上传的原件不是本产品生成的）");
  assert.equal(isHouseStyled(keepHouseMark(draft, edited)), true, "原本带标记的草稿放回标记");
  const upload = sanitizeDocx(draft).docx;
  assert.equal(isHouseStyled(keepHouseMark(upload, edited)), false, "原件本没有标记的不加");
});
