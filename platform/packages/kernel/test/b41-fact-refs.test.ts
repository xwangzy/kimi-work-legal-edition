/**
 * V16 第 41 批：交付件里写“事实 N”，读者手里没有事实表（回归评分二 m03、m05、m16、m20、m25、m26：事实清单只在产品界面里，文件离开界面就对不上）。
 * - 表格：单元格里出现“事实 N”（容忍“事实N”“事实 3、5”“事实 3—7”“事实3至事实7”）时自动追加“事实对照”工作表，只列被引用到的序号；
 *   助手自己给了同名工作表的不重复加；工作表已到上限不加并在返回里说明；xlsx.edit_cells 改后按新的引用重新生成；
 * - Word：内部文书（备忘录、分析、草稿……）文末自动加一节“事实对照”；对外文书不加，由交付前检查报出改成证据名称；
 *   docx.edit_draft 改后这一节按新的引用重新生成（不重复追加）；
 * - 没有引用时什么都不加。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { extractParagraphs, readCreatedXlsx } from "@zr-legal/docx-engine";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { checkDeliverable, factRefNos, isInternalDocument } from "../src/services/deliverable-check.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "fact-refs-firm");
});
after(async () => {
  await tk.kernel.close();
});

async function agentFor(matterId: string, label: string) {
  const { Agent, fetch } = await import("undici");
  const live = liveTaskIdentity(tk, matterId, label);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) => {
    const r = (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r).slice(0, 600)}`);
    return r.result.structuredContent;
  };
  return { live, call, close: () => agent.close() };
}

const fileOf = (id: string) => tk.kernel.blobs.read(tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [id])!.storage_uri);
const sheetsOf = (id: string) => readCreatedXlsx(fileOf(id))!;
const parasOf = (id: string) => extractParagraphs(fileOf(id)).map((p) => p.text);

async function matterWithFacts(title: string) {
  const { matter } = await tk.inv("matters.create", { title, stance: "原告", consent_status: "agreed" });
  const a = await agentFor(matter.matter_id, title);
  await a.call("facts.submit", {
    facts: [
      { statement: "双方于2026年3月1日签订购销合同", kind: "claimed", occurred_on: "2026-03-01" },
      { statement: "原告于2026年3月15日交付货物", kind: "claimed", occurred_on: "2026-03-15" },
      { statement: "被告于2026年4月1日部分付款", kind: "claimed", occurred_on: "2026-04-01" },
      { statement: "被告于2026年5月8日确认欠款", kind: "claimed", occurred_on: "2026-05-08" },
    ],
  });
  const all = await tk.inv("facts.list", { matter_id: matter.matter_id });
  await tk.inv("facts.decide", { matter_id: matter.matter_id, fact_id: all.facts.find((f: any) => /签订购销合同/.test(f.statement)).fact_id, decision: "confirm" });
  return { matter, a };
}

test("认“事实 N”的各种写法；内部 / 对外文书的判断", () => {
  assert.deepEqual(factRefNos("见事实 12；事实3、5；事实 7—9；事实10至事实11；事实 14-15"), [3, 5, 7, 8, 9, 10, 11, 12, 14, 15]);
  assert.deepEqual(factRefNos("事实2026年发生的；事实上；事实 2，30日内"), [2], "年份、“事实上”、后接日数的不算");
  assert.deepEqual(factRefNos("没有引用"), []);
  for (const t of ["案情分析备忘录", "争点分析", "法律意见书草稿", "起草说明与待定事项", "庭审提纲", "审查意见书（内部稿）"]) assert.equal(isInternalDocument(t), true, t);
  for (const t of ["民事起诉状", "律师函", "法律意见书", "案件进展汇报", "设备买卖合同"]) assert.equal(isInternalDocument(t), false, t);
  const outward = checkDeliverable("民事起诉状", [{ heading: "事实与理由", paragraphs: ["被告确认欠款（事实 4）。"] }]);
  assert.ok(outward.issues.some((i) => i.kind === "note_to_lawyer" && /事实 4/.test(i.text) && /证据或材料的名称/.test(i.fix)), JSON.stringify(outward.issues));
  assert.equal(checkDeliverable("案情分析备忘录", [{ heading: "事实", paragraphs: ["被告确认欠款（事实 4）。"] }]).issues.some((i) => /事实/.test(i.text)), false, "内部文书不报");
  assert.equal(checkDeliverable("计算明细", [{ heading: "表", paragraphs: [], table: { columns: ["出处"], rows: [["事实 4"]] } }], { table: true }).issues.length, 0, "表格不报（自动附表）");
});

test("表格：自动附“事实对照”、只列被引用的序号；助手自己给了同名表不重复加；改表后随引用更新；没有引用什么都不加", { timeout: 120_000 }, async () => {
  const { a } = await matterWithFacts("事实对照·表格");
  try {
    const t1 = await a.call("xlsx.render_table", { title: "争点—证据矩阵", sheets: [{ name: "要件矩阵", columns: ["要件", "出处"], rows: [["合同成立", "事实1"], ["欠款金额", "事实 3、4；事实 9"]] }] });
    let s = sheetsOf(t1.artifact_version_id);
    assert.deepEqual(s.map((x) => x.name), ["要件矩阵", "事实对照"]);
    assert.deepEqual(s[1]!.rows[0], ["序号", "事实陈述", "发生日期", "来源材料", "律师是否已确认"]);
    assert.deepEqual(s[1]!.rows.slice(1).map((r) => [r[0], r[1], r[2] ?? null, r[4] ?? null]), [
      ["事实 1", "双方于2026年3月1日签订购销合同", "2026-03-01", "已确认"],
      ["事实 3", "被告于2026年4月1日部分付款", "2026-04-01", "待确认"],
      ["事实 4", "被告于2026年5月8日确认欠款", "2026-05-08", "待确认"],
    ]);
    // V18 第 43 批：事实清单里没有的序号（事实 9）不写进成果，只在工具返回里告诉助手改正引用
    assert.equal(s[1]!.rows.some((r) => String(r[0]) === "事实 9"), false);
    assert.match(t1.fact_sheet, /已自动附上工作表“事实对照”[\s\S]*不要再手工做一张/);
    assert.match(t1.fact_sheet, /事实 9 在本事项的事实清单里没有这一序号[\s\S]*facts\.list/);
    // 改表：引用从 3、4、9 改成 2，对照表随之更新（仍只有一张）
    const r1 = await a.call("xlsx.edit_cells", { artifact_version_id: t1.artifact_version_id, edits: [{ sheet: "要件矩阵", row: 2, column: "出处", value: "事实 2" }] });
    s = sheetsOf(r1.artifact_version_id);
    assert.deepEqual(s.map((x) => x.name), ["要件矩阵", "事实对照"]);
    assert.deepEqual(s[1]!.rows.slice(1).map((r) => r[0]), ["事实 1", "事实 2"]);
    // 助手自己给了“事实对照”：不另加，提示核对
    const own = await a.call("xlsx.render_table", { title: "计算明细", sheets: [{ name: "明细", columns: ["项目", "出处"], rows: [["本金", "事实 3"]] }, { name: "事实对照", columns: ["序号", "内容"], rows: [["事实 3", "部分付款"]] }] });
    assert.deepEqual(sheetsOf(own.artifact_version_id).map((x) => x.name), ["明细", "事实对照"]);
    assert.match(own.fact_sheet, /已有你写的“事实对照”工作表，系统没有另加/);
    // 没有引用：不加
    const none = await a.call("xlsx.render_table", { title: "期限表", sheets: [{ name: "期限", columns: ["事项", "届满日"], rows: [["上诉期", "2026-11-20"]] }] });
    assert.deepEqual(sheetsOf(none.artifact_version_id).map((x) => x.name), ["期限"]);
    assert.equal(none.fact_sheet, undefined);
    // 工作表已到上限（12 张）：不加并说明
    const full = await a.call("xlsx.render_table", { title: "十二张", sheets: Array.from({ length: 12 }, (_, i) => ({ name: `表${i + 1}`, columns: ["出处"], rows: [["事实 1"]] })) });
    assert.equal(sheetsOf(full.artifact_version_id).length, 12);
    assert.match(full.fact_sheet, /工作表已有 12 张（上限），系统没能附上“事实对照”/);
  } finally {
    await a.close();
  }
});

test("Word：内部文书文末附“事实对照”一节，改后随引用重新生成、不重复追加；对外文书不加、交付前检查报出", { timeout: 120_000 }, async () => {
  const { a } = await matterWithFacts("事实对照·文书");
  try {
    const memo = await a.call("docx.render_report", { title: "案情分析备忘录", sections: [{ heading: "一、事实", paragraphs: ["双方签订合同（事实 1），被告部分付款（事实 3）。"] }] });
    let p = parasOf(memo.artifact_version_id);
    assert.ok(p.includes("事实对照"), p.join("\n"));
    assert.ok(p.some((x) => x.startsWith("（本节列出正文引用的各项事实及其出处")));
    assert.ok(p.includes("被告于2026年4月1日部分付款"));
    assert.equal(p.includes("原告于2026年3月15日交付货物"), false, "只列被引用的");
    assert.match(memo.fact_table, /文末自动加了一节“事实对照”/);
    assert.equal(memo.quality_check?.issues?.some((i: any) => /事实 \d/.test(i.text)) ?? false, false);
    // 改：把“事实 3”改成“事实 2、4”——这一节重新生成，仍只有一节
    const e1 = await a.call("docx.edit_draft", { artifact_version_id: memo.artifact_version_id, patches: [{ anchor: "被告部分付款（事实 3）", proposed_text: "原告交付货物、被告确认欠款（事实 2、4）" }] });
    assert.equal(e1.status, "applied");
    p = parasOf(e1.artifact_version_id);
    assert.equal(p.filter((x) => x === "事实对照").length, 1, "不重复追加");
    assert.ok(p.includes("原告于2026年3月15日交付货物") && p.includes("被告于2026年5月8日确认欠款"));
    assert.equal(p.includes("被告于2026年4月1日部分付款"), false, "不再引用的去掉");
    assert.match(e1.fact_table, /重新生成/);
    // 改到一处都不引用：整节去掉
    const e2 = await a.call("docx.edit_draft", { artifact_version_id: e1.artifact_version_id, patches: [{ anchor: "双方签订合同（事实 1），原告交付货物、被告确认欠款（事实 2、4）。", proposed_text: "双方签订合同，原告交付货物、被告确认欠款。" }] });
    p = parasOf(e2.artifact_version_id);
    assert.equal(p.includes("事实对照"), false, p.join("\n"));
    // 对外文书：不加，交付前检查报出
    const filing = await a.call("docx.render_report", { title: "民事起诉状", sections: [{ heading: "事实与理由", paragraphs: ["被告确认欠款（事实 4）。"] }] });
    assert.equal(parasOf(filing.artifact_version_id).includes("事实对照"), false);
    assert.equal(filing.fact_table, undefined);
    assert.ok(filing.quality_check.issues.some((i: any) => /事实 4/.test(i.text) && /证据或材料的名称/.test(i.fix)), JSON.stringify(filing.quality_check.issues));
    // 没有引用的内部文书：不加
    const plain = await a.call("docx.render_report", { title: "研究备忘录", sections: [{ heading: "结论", paragraphs: ["可以主张违约金。"] }] });
    assert.equal(parasOf(plain.artifact_version_id).includes("事实对照"), false);
  } finally {
    await a.close();
  }
});

test("引用的事实序号在事实清单里一个都对不上：不附对照表，只告诉助手改正引用（V18 第 43 批真实回归 m20：系统提示行随成果交了出去）", async () => {
  const { a } = await matterWithFacts("事实对照·全对不上");
  try {
    const t = await a.call("xlsx.render_table", { title: "来源目录", sheets: [{ name: "来源目录", columns: ["法源", "用于"], rows: [["民法典第六百二十一条", "事实 23"]] }] });
    assert.deepEqual(sheetsOf(t.artifact_version_id).map((x) => x.name), ["来源目录"]);
    assert.match(String(t.fact_sheet ?? ""), /事实 23 在本事项的事实清单里没有这一序号/);
  } finally {
    await a.close?.();
  }
});
