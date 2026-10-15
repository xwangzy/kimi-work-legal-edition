/**
 * 进所评测（S8 来源 B；services/recall-eval.ts）：打开文书与标注文件、一致性、裁决、评测都在本机；
 * 保存标注只写到选定位置（不得写进数据根）；导出报告由内核重新计算、只含计数——不含文书原文、文书名与当事人；
 * 不建事项、不进块存储；审计只记动作。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeKernel } from "./helpers.ts";

process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "recall-eval-test-secret-0123456789";

const T = "原告：欧阳明月，电话 13911112222。被告：上海柳城建材有限公司。欧阳明月主张借款本金。证人李某某出庭。";
const span = (v: string, category: string, person_id?: string, from = 0) => {
  const start = T.indexOf(v, from);
  return { start, end: start + v.length, category, ...(person_id ? { person_id } : {}) };
};
const A = { doc_id: "借条-1", source: "firm_onsite", text: T, known_parties: [{ name: "欧阳明月", kind: "person" }], spans: [span("欧阳明月", "person", "P1"), span("13911112222", "phone"), span("上海柳城建材有限公司", "org"), span("欧阳明月", "person", "P1", 20), span("李某某", "person_partial")] };
const B = { ...A, spans: [span("欧阳明月", "person", "Q"), span("13911112222", "phone"), span("柳城建材有限公司", "org"), span("欧阳明月", "person", "Q", 20)] };
const SECRETS = ["欧阳明月", "13911112222", "柳城建材", "借条-1", "李某某"];

test("进所评测：打开、一致性、裁决、评测、保存；报告只含计数；不建事项、不进块存储；审计只记动作", { timeout: 120_000 }, async () => {
  const tk = await makeKernel({}, "recall-eval");
  try {
    const dir = mkdtempSync(join(tmpdir(), "kwl-eval-"));
    // 打开待标注文书（txt）与标注文件（jsonl）
    writeFileSync(join(dir, "借条-1.txt"), T);
    const opened = await tk.inv("eval.open", { path: join(dir, "借条-1.txt") });
    assert.equal(opened.kind, "text");
    assert.equal(opened.docs[0].text, T);
    assert.equal(opened.docs[0].doc_id, "借条-1");
    writeFileSync(join(dir, "a.jsonl"), JSON.stringify(A) + "\n");
    const ann = await tk.inv("eval.open", { path: join(dir, "a.jsonl") });
    assert.equal(ann.kind, "annotations");
    assert.equal(ann.docs[0].spans.length, 5);
    // 符号链接不跟随；不支持的类型拒绝；坏行报行号
    symlinkSync(join(dir, "a.jsonl"), join(dir, "link.jsonl"));
    await assert.rejects(() => tk.inv("eval.open", { path: join(dir, "link.jsonl") }), (e: any) => e.code === "validation");
    writeFileSync(join(dir, "x.exe"), "MZ");
    await assert.rejects(() => tk.inv("eval.open", { path: join(dir, "x.exe") }), (e: any) => e.code === "validation");
    writeFileSync(join(dir, "bad.jsonl"), JSON.stringify(A) + "\n{oops\n");
    await assert.rejects(() => tk.inv("eval.open", { path: join(dir, "bad.jsonl") }), (e: any) => /第 2 行/.test(e.message));
    // 重叠区间的标注被拒（错误信息只含位置，不含原文）
    const overlap = { ...A, spans: [{ start: 3, end: 7, category: "person", person_id: "P1" }, { start: 5, end: 9, category: "org" }] };
    await assert.rejects(() => tk.inv("eval.recall", { docs: [overlap] }), (e: any) => /区间重叠/.test(e.message) && !SECRETS.some((s) => e.message.includes(s)));

    // 一致性与裁决
    const ag = await tk.inv("eval.agreement", { a: [A], b: [B] });
    assert.equal(ag.report.paired, 1);
    assert.equal(ag.groups.length, 2, "机构边界不同 + 隐名只在甲");
    const adj = await tk.inv("eval.adjudicate", { a: A, b: B, decisions: [{ group: 0, decision: "a" }, { group: 1, decision: "a" }] });
    assert.deepEqual(adj.undecided, []);
    assert.equal(adj.doc.spans.length, 5);

    // 评测：同时给有词典与只靠规则；返回只含计数
    const r = await tk.inv("eval.recall", { docs: [adj.doc] });
    assert.equal(r.report.format, "kwl-s8-report/1");
    assert.ok(r.report.with_dictionary.firm_onsite.recallByCategory.person.numerator === 2);
    const rText = JSON.stringify(r);
    for (const s of SECRETS) assert.ok(!rText.includes(s), `评测结果不得含 ${s}`);

    // 保存标注（含原文，到选定位置）与导出报告（内核重新计算，只含计数）
    const work = join(dir, "标注.jsonl");
    await tk.inv("eval.save_work", { docs: [adj.doc], save_path: work });
    assert.ok(readFileSync(work, "utf8").includes("欧阳明月"), "标注文件含原文（留在律所）");
    const rep = join(dir, "报告.md");
    await tk.inv("eval.save_report", { docs: [adj.doc], save_path: rep, report_text: "欧阳明月 13911112222" });
    const reportText = readFileSync(rep, "utf8");
    for (const s of SECRETS) assert.ok(!reportText.includes(s), `报告不得含 ${s}（界面传来的文字也不得进入报告）`);
    assert.match(reportText, /机读数据/);
    // 来源只认登记值（复核 S6A-01）：来源会进报告标题与机读键，自由文字被拒
    await assert.rejects(() => tk.inv("eval.save_report", { docs: [{ ...adj.doc, source: "欧阳明月 13911112222" }], save_path: join(dir, "x.md") }), (e: any) => /来源只能是/.test(e.message) && !SECRETS.some((s) => e.message.includes(s)));
    // 不得写进数据根
    await assert.rejects(() => tk.inv("eval.save_work", { docs: [adj.doc], save_path: join(tk.kernel.config.workspaceDir, "x.jsonl") }), (e: any) => e.code === "validation");

    // 不建事项、不进块存储；审计只记动作，不含文书名与内容
    assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matters`)!.n, 0);
    assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM document_versions`)!.n, 0);
    const audits = tk.kernel.db.all<Record<string, unknown>>(`SELECT * FROM audit_events WHERE action LIKE 'eval.%'`);
    assert.deepEqual([...new Set(audits.map((a) => a.action))].sort(), ["eval.open", "eval.recall", "eval.save_report", "eval.save_work"]);
    const auditText = JSON.stringify(audits);
    for (const s of SECRETS) assert.ok(!auditText.includes(s), `审计不得含 ${s}`);
  } finally {
    await tk.kernel.close();
  }
});
