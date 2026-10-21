/**
 * v9.4（U1 #1、#2；复核 Q1-19、Q1-23）：整理案卷与合同审查的成果是要交给合伙人或客户的——
 * 表格与文书里不出现 sha256、字符数、解析器内部标记；文件名用日期，不带任务编号尾巴。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readZipEntries } from "@zr-legal/docx-engine";
import { buildS2Deliverables, fileDay } from "../src/executor/casefile.ts";

const runId = "run_0123456789abcdef-b35186";
const built = buildS2Deliverables({
  runId,
  matter: { title: "示例", client_name: null, counterparty: null, stance: "原告" },
  materials: [
    { document_version_id: "dv1", parse_version_id: "pv1", filename: "买卖合同.docx", sha256: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", chars: 1234, quality_flags: ["v0_crude_docx_parser", "no_page_anchors", "comments_revisions_ignored"], text: "2026年3月1日，甲方应支付货款人民币500000元。" },
    { document_version_id: "dv2", parse_version_id: "pv2", filename: "扫描件.pdf", sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", chars: 99, quality_flags: [], text: "对账确认", page_count: 3, pages: [{ pageNo: 2, quality: "low" }, { pageNo: 3, quality: "unreadable" }] },
  ],
  issues: ["货款是否已付清"],
});

/** 每份成果里的全部文字（xlsx 共享字符串与工作表、docx 正文）。 */
function textOf(bytes: Buffer): string {
  const z = readZipEntries(bytes);
  return [...z.entries()].filter(([k]) => /\.xml$/.test(k)).map(([, v]) => v.toString("utf8")).join("\n");
}

test("成果内容不含 sha256、字符数与解析器内部标记；读取情况与备注用律师话", () => {
  for (const f of built.files) {
    const t = textOf(f.bytes);
    assert.doesNotMatch(t, /sha256|a1b2c3d4e5f6|大小\(字符\)|文件ID|v0_|no_page_anchors|comments_revisions_ignored|v0 解析|materials\.reparse|锚点/, f.filename);
  }
  const catalog = textOf(built.files.find((f) => f.kind === "s2_catalog")!.bytes);
  assert.match(catalog, /只读了正文文字（批注、修订痕迹未读）/);
  assert.match(catalog, /有 1 页读不出/);
});

test("文件名用日期，不带任务编号尾巴（整理案卷与合同审查）", () => {
  for (const f of built.files) {
    assert.ok(f.filename.includes(fileDay()), f.filename);
    assert.doesNotMatch(f.filename, /b35186|-[0-9a-f]{6}\./, f.filename);
  }
  const src = readFileSync(new URL("../src/executor/deliverables.ts", import.meta.url), "utf8") + readFileSync(new URL("../src/executor/executor.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /filename: `[^`]*\$\{[^}]*\.slice\(-6\)\}/, "成果文件名不再拼任务编号尾巴");
  assert.equal(fileDay(new Date(2026, 0, 5)), "2026-01-05");
});
