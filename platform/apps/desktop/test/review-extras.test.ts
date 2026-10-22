/**
 * v9.4 第 20 批：表格审阅残余（按列排序、复核模式、据此起草、自建列）与工作台残余（批量接受边界、误报驳回、意见表 Word、对外版提示）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { draftLabel, nextOpenCell, sortDocs } from "../src/lib/table-review.ts";
import { batchEligible } from "../src/lib/workbench.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("按列排序：升、降、空值排后、同值保持原顺序；按材料名", () => {
  const docs = [
    { document_version_id: "a", filename: "乙.docx" },
    { document_version_id: "b", filename: "甲.docx" },
    { document_version_id: "c", filename: "丙.docx" },
  ];
  const val: Record<string, string> = { a: "2026-03", b: "", c: "2025-12" };
  const v = (d: { document_version_id: string }) => val[d.document_version_id]!;
  assert.deepEqual(sortDocs(docs, "x", 1, v).map((d) => d.document_version_id), ["c", "a", "b"]);
  assert.deepEqual(sortDocs(docs, "x", -1, v).map((d) => d.document_version_id), ["a", "c", "b"], "降序时空值仍在后");
  assert.deepEqual(sortDocs(docs, null, 1, v).map((d) => d.document_version_id), ["a", "b", "c"]);
  assert.equal(sortDocs(docs, "__doc", 1, v).length, 3);
});

test("复核模式：J/K 在未核格子间按行走，首尾相接；全核完返回 null", () => {
  const rows = [{ document_version_id: "a" }, { document_version_id: "b" }];
  const cols = [{ key: "x" }, { key: "y" }];
  const open = new Set(["a|y", "b|x"]);
  const isOpen = (d: string, c: string) => open.has(`${d}|${c}`);
  assert.deepEqual(nextOpenCell(rows, cols, isOpen, null, 1), { doc: "a", col: "y" });
  assert.deepEqual(nextOpenCell(rows, cols, isOpen, { doc: "a", col: "y" }, 1), { doc: "b", col: "x" });
  assert.deepEqual(nextOpenCell(rows, cols, isOpen, { doc: "b", col: "x" }, 1), { doc: "a", col: "y" }, "首尾相接");
  assert.deepEqual(nextOpenCell(rows, cols, isOpen, { doc: "a", col: "y" }, -1), { doc: "b", col: "x" });
  assert.deepEqual(nextOpenCell(rows, cols, isOpen, null, -1), { doc: "b", col: "x" });
  assert.equal(nextOpenCell(rows, cols, () => false, null, 1), null);
});

test("据此起草的按钮按模板写；表格审阅有排序、复核模式、看原文前后、推为事实、加一列、去掉自建列（两步确认，不用原生确认框）", () => {
  assert.equal(draftLabel("evidence_list"), "据此起草证据目录");
  assert.equal(draftLabel("dd_contract_summary"), "据此起草尽调发现");
  assert.equal(draftLabel("contract_ledger"), "据此设到期提醒");
  const t = src("components/TableReview.tsx");
  for (const s of ["th-sort", "复核模式", "看原文前后", "推为事实", "加一列", "<ConfirmButton", "逐条确认"]) assert.ok(t.includes(s), s);
  assert.ok(!/window\.confirm|\bconfirm\(/.test(t), "不用浏览器原生确认框");
});

test("批量接受的边界与内核同一判定：只收提示级与前后不一致；重大、必须修改、缺失、需客户决定、没建议的不收", () => {
  const base = { status: "proposed", suggestion: "改为……", kind: "risk", needs_client_decision: false, nature: "should", severity: "low" };
  assert.equal(batchEligible(base), true);
  assert.equal(batchEligible({ ...base, severity: "mid" }), false);
  assert.equal(batchEligible({ ...base, severity: "mid", kind: "consistency" }), true);
  assert.equal(batchEligible({ ...base, severity: "high", kind: "consistency" }), false);
  assert.equal(batchEligible({ ...base, nature: "must" }), false);
  assert.equal(batchEligible({ ...base, kind: "missing" }), false);
  assert.equal(batchEligible({ ...base, needs_client_decision: true }), false);
  assert.equal(batchEligible({ ...base, suggestion: " " }), false);
  assert.equal(batchEligible({ ...base, status: "accepted" }), false);
  // 与内核判定逐行一致
  const kernel = readFileSync(new URL("../../../packages/kernel/src/services/review-cards.ts", import.meta.url), "utf8");
  const body = (s: string) => /export function batchEligible[\s\S]*?\): boolean \{([\s\S]*?)\n\}/.exec(s)![1]!.replace(/\s+/g, " ").replace(/!!c\.needs_client_decision/g, "c.needs_client_decision").trim();
  assert.equal(body(src("lib/workbench.ts")), body(kernel));
});

test("工作台：批量勾选与撤回本批、缺失卡“误报：其实有”、意见表 Word、对外版的可见提示", () => {
  const w = src("components/ReviewWorkbench.tsx");
  for (const s of ["接受所选", "撤回本批", "误报：其实有", "驳回并记住", "意见表 Word", "对外版只有修订，不带批注、理由、规则号和底线"]) assert.ok(w.includes(s), s);
});

test("对方改动模式：有基线时可切“只看对方改动”，每处并排我方原稿与对方改稿，卡上三个动作（接受对方 / 恢复我方 / 改用退让文本）", () => {
  const w = src("components/ReviewWorkbench.tsx");
  for (const s of ["只看对方改动", "我方原稿", "对方改稿", "静默改动", "接受对方", "恢复我方", "改用退让文本", "api.counterChanges"]) assert.ok(w.includes(s), s);
  assert.ok(/counter\?\.available && \(/.test(w), "没有基线时不出切换");
});

test("入口：整理案卷精读版接 casefile-organize（视角作方法参数）；即将推出只灰显不能发起；工作台处理完直达修订说明；金额测算可选 LPR 倍数与劳动补偿", async () => {
  const { SCENARIOS, COMING_SOON, buildGoal } = await import("../src/lib/scenarios.ts");
  const deep = SCENARIOS.find((c) => c.id === "casefile-deep")!;
  assert.equal(deep.skill, "casefile-organize");
  assert.equal(buildGoal(deep, {}, ""), "请逐份精读本事项的案卷材料，编目、按时间整理事实（每条附原文）并列出缺口。", "视角没填整句省略");
  assert.match(buildGoal(deep, { perspective: "按付款线索" }, ""), /时间线按“按付款线索”排列/);
  assert.ok(COMING_SOON.length >= 8 && COMING_SOON.every((x) => !SCENARIOS.some((c) => c.title === x.title)));
  assert.ok(src("pages/Methods.tsx").includes('aria-disabled="true"'));
  assert.ok(src("pages/Home.tsx").includes("即将推出："));
  assert.ok(src("components/ReviewWorkbench.tsx").includes("/start/redline-notes/${matterId}"));
  const amount = SCENARIOS.find((c) => c.id === "amount")!;
  assert.ok(amount.fields.some((f) => (f.options ?? []).includes("LPR 倍数（如上浮 50%）")));
});
