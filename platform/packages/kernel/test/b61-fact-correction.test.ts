/**
 * 第 61 批（V35）真实验收 m03-issues 记“部分完成”的根因：独立复核要求改表格里系统附的“事实对照”中一条事实的发生日期；
 * 修改轮逐格改了，保存时“事实对照”按事实页重新生成，改动被覆盖——没有任何工具能更正已提交的事实，必须改永远落实不了。
 * 修复：facts.submit 带 fact_id 更正本任务提交、律师尚未确认的事实；xlsx.edit_cells 改“事实对照”时说清走法，refresh_facts 按更正后的事实重新生成。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readCreatedXlsx } from "@zr-legal/docx-engine";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "fact-correction-firm");
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

test("更正本任务未确认的事实；“事实对照”逐格改被退回并说明走法；refresh_facts 按更正后的事实重新生成；律师已确认的、别的任务的不能改", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "事实更正", stance: "原告", consent_status: "agreed" });
  const a = await agentFor(matter.matter_id, "fixfact");
  const sub = await a.call("facts.submit", { facts: [
    { statement: "3号机2026年6月21日报修，6月22日临时处理", kind: "claimed", occurred_on: "2026-07-28" },
    { statement: "双方于2025年9月12日签订设备买卖合同", kind: "claimed", occurred_on: "2025-09-12" },
  ] });
  const wrong = sub.facts[0];
  const t1 = await a.call("xlsx.render_table", { title: "争点—证据矩阵", sheets: [{ name: "要件矩阵", columns: ["要件", "出处"], rows: [["质量瑕疵与修复", wrong.ref]] }] });
  const factSheet = () => readCreatedXlsx(fileOf(t1.artifact_version_id))!.find((s) => s.name === "事实对照")!;
  assert.ok(JSON.stringify(factSheet().rows).includes("2026-07-28"));
  // 逐格改“事实对照”：退回并说明用 facts.submit 带 fact_id 更正、再 refresh_facts
  const r1 = await a.call("xlsx.edit_cells", { artifact_version_id: t1.artifact_version_id, edits: [{ sheet: "事实对照", row: 1, column: "发生日期", value: "2026-06-21" }] }).catch((e: unknown) => e);
  const rejectText = JSON.stringify(r1);
  assert.match(rejectText, /facts\.submit 带这条事实的 fact_id 更正/);
  // 更正事实
  const fix = await a.call("facts.submit", { facts: [{ fact_id: wrong.fact_id, statement: "3号机2026年6月21日报修，6月22日临时处理", kind: "claimed", occurred_on: "2026-06-21" }] });
  assert.deepEqual(fix.corrected.map((x: any) => x.fact_id), [wrong.fact_id]);
  assert.equal(tk.kernel.db.get<{ occurred_on: string }>(`SELECT occurred_on FROM matter_facts WHERE fact_id = ?`, [wrong.fact_id])!.occurred_on, "2026-06-21");
  // 只重建“事实对照”
  const latestId = tk.kernel.db.get<{ artifact_version_id: string }>(`SELECT artifact_version_id FROM artifact_versions WHERE run_id = ? AND filename LIKE '争点—证据矩阵%' ORDER BY created_at DESC LIMIT 1`, [a.live.rid])!.artifact_version_id;
  const r2 = await a.call("xlsx.edit_cells", { artifact_version_id: latestId, refresh_facts: true });
  const rows = JSON.stringify(readCreatedXlsx(fileOf(r2.artifact_version_id))!.find((s) => s.name === "事实对照")!.rows);
  assert.ok(rows.includes("2026-06-21") && !rows.includes("2026-07-28"), rows);
  // 律师已确认的不能改；别的任务提交的不能改
  await tk.inv("facts.decide", { matter_id: matter.matter_id, fact_id: sub.facts[1].fact_id, decision: "confirm" });
  const no1 = await a.call("facts.submit", { facts: [{ fact_id: sub.facts[1].fact_id, statement: "改", occurred_on: "2025-09-13" }] });
  assert.match(no1.rejected[0].reason, /律师已确认/);
  const b = await agentFor(matter.matter_id, "other");
  const no2 = await b.call("facts.submit", { facts: [{ fact_id: wrong.fact_id, statement: "改", occurred_on: "2026-06-20" }] });
  assert.match(no2.rejected[0].reason, /不是本任务提交的/);
  await a.close();
  await b.close();
});
