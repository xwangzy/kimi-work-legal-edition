/** v9.3 第 15 批 B-4：下载按钮的说法与 Markdown 成果下载成 Word；上传模板与样张经主进程系统对话框（句柄换路径）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { downloadPlan } from "../src/lib/download.ts";

const require = createRequire(import.meta.url);
const { resolveFileParams } = require("../electron/file-dialogs.cjs") as { resolveFileParams: (m: string, p: unknown, s: { take: (h: unknown, kind: string) => string | null }) => any };

test("B-4 下载按钮：Markdown 下载成 Word（文件名改 .docx），Word / Excel / PDF 照原样", () => {
  assert.deepEqual(downloadPlan("研究备忘录.md"), { label: "下载 Word", as: "docx", saveName: "研究备忘录.docx" });
  assert.deepEqual(downloadPlan("意见书.docx"), { label: "下载 Word", as: null, saveName: "意见书.docx" });
  assert.equal(downloadPlan("表.xlsx").label, "下载 Excel");
  assert.equal(downloadPlan("判决.pdf").label, "下载 PDF");
  assert.deepEqual(downloadPlan("说明.txt"), { label: "下载", as: null, saveName: "说明.txt" });
});

test("B-4 上传律所模板、下载样张：主进程把对话框句柄换成内核参数，页面自带的路径一律剥掉", () => {
  const store = { take: (h: unknown, kind: string) => (h === "h1" ? `/Users/x/${kind}.dotx` : null) };
  assert.deepEqual(resolveFileParams("doc_style.set_template", { file_handle: "h1", filename: "模板.dotx", file: "/etc/passwd" }, store).params, { filename: "模板.dotx", file: "/Users/x/open.dotx" });
  assert.deepEqual(resolveFileParams("doc_style.sample", { save_handle: "h1", save_path: "/tmp/x" }, store).params, { save_path: "/Users/x/save.dotx" });
  assert.ok(resolveFileParams("doc_style.set_template", { file_handle: "bad" }, store).error);
});
