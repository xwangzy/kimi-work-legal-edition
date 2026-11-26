/**
 * 第 71 批 D1 / D2（第 70 批验收）：复核页“系统已核对”的两处口径。
 * D1：开始面板一份材料都不勾（D-183：本事项材料都可读、助手按需读取），复核页原先写“材料读取：已读 0/0 份”并打绿勾，
 *     而助手实际读了 3 份。根因：完整性单只看发起时的勾选（materials.loaded 的 loaded / requested），没有实际读取记录。
 *     现在发起时记下本事项现行材料（on_demand），工具账本记下每次读取的材料编号，完整性单按“实际读过 / 本事项现行材料”给出。
 * D2：同一页“引用核验：本成果没有引用核验记录”，下方却列出 10 处已核引用。根因：这一行只认运行中对材料的核验事件
 *     citations.verified（只有合同审查默认路径才写），而下方与签发门禁用的是成果文件自身的核验 artifact_citations。
 *     内核两项都照给，界面改成同源（见 apps/desktop/test/b71-defect-fixes.test.ts）；这里核对内核给出的两个来源确实如此。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { importText, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { materialIdsRead, materialsCheckOf, onDemandMaterialsOf } from "../src/services/material-reads.ts";
import { toolResultSummary, toolResultSummaryJson } from "../src/tools/result-summary.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b71-material-reads-firm");
});
after(async () => {
  await tk.kernel.close();
});

async function agentFor(matterId: string, label: string, selected: string[]) {
  const { Agent, fetch } = await import("undici");
  const live = liveTaskIdentity(tk, matterId, label);
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ document_version_ids: selected }), live.rid]);
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
const parseOf = (docId: string) => tk.kernel.db.get<{ parse_version_id: string }>(`SELECT parse_version_id FROM parse_versions WHERE document_version_id = ? ORDER BY created_at DESC LIMIT 1`, [docId])!.parse_version_id;

test("D1 根因：工具账本只给读材料片段记材料编号（不透明编号，不含文件名与正文），别的工具不记", () => {
  const read = { parse_version_id: "pv_1", document_version_id: "dv_abc123", text: "张三诉李四", char_start: 0, char_end: 5, total_chars: 5, text_hash: "x" };
  assert.equal(toolResultSummary(read, "materials.read_excerpt")?.doc, "dv_abc123");
  assert.equal(toolResultSummary(read, "docx.revise")?.doc, undefined, "别的工具结果里的 document_version_id 不是“读过”");
  assert.equal(toolResultSummary(read)?.doc, undefined);
  assert.doesNotMatch(toolResultSummaryJson(read, "materials.read_excerpt") ?? "", /张三|李四/);
  // 编号不像编号的（含中文、空格）不记
  assert.equal(toolResultSummary({ ...read, document_version_id: "张三 的合同" }, "materials.read_excerpt")?.doc, undefined);
});

test("D1：没勾材料的任务经本机工具端点读了 2 份（其中一份读两次）→ 实际读过 2 份、本事项现行材料 3 份，没读的列出文件名", async () => {
  const { matter } = await tk.inv("matters.create", { title: "按需读取·复核页计数", stance: "原告", consent_status: "agreed" });
  const a = await importText(tk.inv, matter.matter_id, "01-设备买卖合同.txt", "第一条 买方应于收货后三十日内付清货款。");
  const b = await importText(tk.inv, matter.matter_id, "03-收款记录.txt", "2026-03-01 收款 100,000 元。");
  const c = await importText(tk.inv, matter.matter_id, "04-对账确认函.txt", "截至 2026-06-30 尚欠 445,000 元。");
  // 发起时（executor 的 stepLoadMaterials 在没勾材料时写进 materials.loaded 的 on_demand）
  const od = onDemandMaterialsOf(tk.kernel.db, matter.matter_id);
  assert.equal(od.total, 3);
  assert.deepEqual(new Set(od.ids), new Set([a.document_version_id, b.document_version_id, c.document_version_id]));

  const ag = await agentFor(matter.matter_id, "b71reads", []);
  try {
    await ag.call("materials.list", {});
    await ag.call("materials.read_excerpt", { parse_version_id: parseOf(a.document_version_id), char_start: 0, char_end: 10 });
    await ag.call("materials.read_excerpt", { parse_version_id: parseOf(a.document_version_id), char_start: 10, char_end: 40 });
    await ag.call("materials.read_excerpt", { parse_version_id: parseOf(c.document_version_id) });
  } finally {
    await ag.close();
  }
  const readIds = materialIdsRead(tk.kernel.db, [ag.live.rid]);
  assert.deepEqual(readIds, new Set([a.document_version_id, c.document_version_id]));
  // 别的任务的读取不算进来
  assert.equal(materialIdsRead(tk.kernel.db, ["run_other"]).size, 0);

  const nameOf = (id: string) => tk.kernel.db.get<{ filename: string }>(`SELECT filename FROM document_versions WHERE document_version_id = ?`, [id])?.filename ?? null;
  const check = materialsCheckOf({ requested: 0, loaded: 0, failed: 0, on_demand: od }, readIds, nameOf);
  assert.deepEqual(check, { on_demand: true, tracked: true, total: 3, read: 2, unread_files: ["03-收款记录.txt"] });

  // 再读第三份：3/3
  const ag2 = await agentFor(matter.matter_id, "b71reads2", []);
  try {
    await ag2.call("materials.read_excerpt", { parse_version_id: parseOf(b.document_version_id) });
  } finally {
    await ag2.close();
  }
  const all = materialIdsRead(tk.kernel.db, [ag.live.rid, ag2.live.rid]);
  assert.deepEqual(materialsCheckOf({ requested: 0, loaded: 0, failed: 0, on_demand: od }, all, nameOf), { on_demand: true, tracked: true, total: 3, read: 3, unread_files: [] });
});

test("D1：勾了材料照旧按发起时载入的份数；老任务没有 on_demand 记录的如实标“没有逐份读取记录”，不推算成 0/0", () => {
  assert.deepEqual(materialsCheckOf({ requested: 2, loaded: 2, failed: 0 }, new Set(), () => null), { loaded: 2, requested: 2, failed: 0 });
  assert.deepEqual(materialsCheckOf({ requested: 3, loaded: 2, failed: 1 }, new Set(["x"]), () => null), { loaded: 2, requested: 3, failed: 1 });
  assert.deepEqual(materialsCheckOf({ requested: 0, loaded: 0, failed: 0 }, new Set(), () => null), { on_demand: true, tracked: false });
  assert.deepEqual(materialsCheckOf(null, new Set(), () => null), { note: "非任务产出" });
  // 本事项没有材料
  assert.deepEqual(materialsCheckOf({ requested: 0, loaded: 0, failed: 0, on_demand: { total: 0, ids: [] } }, new Set(), () => null), { on_demand: true, tracked: true, total: 0, read: 0, unread_files: [] });
});

test("D1 / D2 经完整性单：没勾材料、读了 2 份的任务产出一份带引用的文书——materials 给 2/3，artifact_citations 有引用而运行级 citations 没有", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "复核页两处口径", stance: "原告", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-26" } });
  const a = await importText(tk.inv, matter.matter_id, "合同.txt", "第一条 买方应于收货后三十日内付清货款。");
  const b = await importText(tk.inv, matter.matter_id, "对账函.txt", "截至 2026-06-30 尚欠 445,000 元。");
  await importText(tk.inv, matter.matter_id, "收款记录.txt", "2026-03-01 收款 100,000 元。");
  const ag = await agentFor(matter.matter_id, "b71compl", []);
  // 发起时的 materials.loaded（与 executor 写的同形）
  tk.kernel.db.run(`INSERT INTO run_events (run_id, attempt_id, seq, type, payload) VALUES (?,?,?,?,?)`, [
    ag.live.rid,
    ag.live.aid,
    20,
    "materials.loaded",
    JSON.stringify({ requested: 0, loaded: 0, failed: 0, files: [], parse_versions: [], on_demand: onDemandMaterialsOf(tk.kernel.db, matter.matter_id) }),
  ]);
  let artId = "";
  try {
    await ag.call("materials.read_excerpt", { parse_version_id: parseOf(a.document_version_id) });
    await ag.call("materials.read_excerpt", { parse_version_id: parseOf(b.document_version_id) });
    const r = await ag.call("docx.render_report", {
      title: "测算说明",
      sections: [{ heading: "一、依据", paragraphs: ["违约金调整依据《中华人民共和国民法典》第五百八十五条第二款。", "利息依据《中华人民共和国民法典》第五百七十七条。"] }],
    });
    artId = r.artifact_version_id;
  } finally {
    await ag.close();
  }
  const out = await tk.inv("review.completeness", { artifact_version_id: artId });
  const m = out.completeness.materials;
  assert.equal(m.on_demand, true);
  assert.equal(m.total, 3);
  assert.equal(m.read, 2);
  assert.deepEqual(m.unread_files, ["收款记录.txt"]);
  assert.equal(m.requested, undefined, "不再给出 0/0");
  // D2 两个来源：成果自身的核验有引用；运行级（材料核验事件）这类任务没有
  assert.ok(out.completeness.artifact_citations?.checked, JSON.stringify(out.completeness.artifact_citations).slice(0, 300));
  assert.ok((out.completeness.artifact_citations?.total ?? 0) >= 2);
  assert.equal(out.completeness.citations.total, undefined);
});
