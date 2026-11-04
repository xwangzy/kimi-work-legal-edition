/**
 * V12（V11 遗留 D7、D8，V12 真实界面走查用例 8 复现）：空文件提示“需要 path 或 data_base64”；同一份文件再传一次静默存两份
 * （整理案卷与证据目录把同一份证据计两次）。改为照常添加并明确提示（不拦：原样退回的回稿要两份才能比对）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createStyledDocx } from "@zr-legal/docx-engine";
import { makeKernel, type TestKernel } from "./helpers.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "v12-import-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("空文件给看得懂的提示；内容相同的文件照常添加但写明与哪一份相同；内容不同照常添加", async () => {
  const { matter } = await tk.inv("matters.create", { title: "导入", stance: "原告" });
  await assert.rejects(tk.inv("materials.import", { matter_id: matter.matter_id, filename: "空文件.docx", data_base64: "" }), /文件是空的/);
  const a = createStyledDocx([{ kind: "title", text: "购销合同" }, { kind: "p", runs: [{ text: "总价 186 万元。" }] }], undefined, null, { mark: false });
  const b = createStyledDocx([{ kind: "title", text: "购销合同" }, { kind: "p", runs: [{ text: "总价 188 万元。" }] }], undefined, null, { mark: false });
  const r1 = await tk.inv("materials.import", { matter_id: matter.matter_id, filename: "C1-购销合同.docx", data_base64: a.toString("base64") });
  const r2 = await tk.inv("materials.import", { matter_id: matter.matter_id, filename: "C1-购销合同（重复）.docx", data_base64: a.toString("base64") });
  assert.equal(r2.duplicate_of, r1.document_version_id, "写明与哪一份相同");
  assert.equal(r2.duplicate_filename, "C1-购销合同.docx");
  assert.notEqual(r2.document_version_id, r1.document_version_id, "照常添加：原样退回、换了名字的回稿要两份才能比对");
  assert.match(r2.note, /内容完全相同/);
  const r3 = await tk.inv("materials.import", { matter_id: matter.matter_id, filename: "C1-购销合同-修改版.docx", data_base64: b.toString("base64") });
  assert.notEqual(r3.document_version_id, r1.document_version_id);
  assert.equal(r3.duplicate_of, undefined);
  // 另一个事项里同一份文件照常添加
  const { matter: m2 } = await tk.inv("matters.create", { title: "另一个事项", stance: "原告" });
  const r4 = await tk.inv("materials.import", { matter_id: m2.matter_id, filename: "C1-购销合同.docx", data_base64: a.toString("base64") });
  assert.equal(r4.duplicate_of, undefined);
});
