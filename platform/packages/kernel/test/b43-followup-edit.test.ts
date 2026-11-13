/**
 * V18 第 43 批续五（偏离 D-185）：追问可以在此前各轮交出的文书、表格上直接改。
 * 原先 docx.edit_draft、xlsx.edit_cells 只认“本任务里生成的”：追问是另一个任务，助手想改上一轮的清单几格被拒绝，只能整表重出
 * （真实追问两次都是先改单元格被拒、再整表重出，慢，还容易带出无关改动）。
 * - 同一条追问链上此前各轮的文件可以改，新版本登记在本轮任务下；
 * - 只能在最新版上改：拿着旧编号改会把其后各版的修改丢掉，拒绝并给出最新版编号；
 * - 别的任务（不在这条追问链上）的文件照旧不能动。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readCreatedXlsx, readZipText } from "@zr-legal/docx-engine";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { chainEditTargets, followUpChain, followUpEditLine } from "../src/executor/executor.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "followup-edit-firm");
});
after(async () => {
  await tk.kernel.close();
});

async function agentFor(matterId: string, label: string, followupOf?: string) {
  const { Agent, fetch } = await import("undici");
  const live = liveTaskIdentity(tk, matterId, label);
  if (followupOf) tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ followup_of: followupOf }), live.rid]);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const raw = async (name: string, args: unknown) =>
    (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
  const call = async (name: string, args: unknown) => {
    const r = await raw(name, args);
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r).slice(0, 600)}`);
    return r.result.structuredContent;
  };
  return { live, raw, call, close: () => agent.close() };
}

const rowOf = (id: string) => tk.kernel.db.get<{ run_id: string; version: number; filename: string; storage_uri: string }>(`SELECT run_id, version, filename, storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [id])!;

test("追问在上一轮的表格与文书上直接改：新版本登记在本轮；旧编号被拒并给出最新版编号；不在这条追问链上的任务照旧不能动", async () => {
  const { matter } = await tk.inv("matters.create", { title: "追问小改", stance: "投资方", consent_status: "agreed" });
  const r1 = await agentFor(matter.matter_id, "r1");
  const r2 = await agentFor(matter.matter_id, "r2", r1.live.rid);
  const r3 = await agentFor(matter.matter_id, "r3", r2.live.rid);
  const other = await agentFor(matter.matter_id, "other");
  try {
    // 第一轮：一张清单、一份备忘录
    const t1 = await r1.call("xlsx.render_table", { title: "交割清单", sheets: [{ name: "先决条件", columns: ["序号", "事项", "状态"], rows: [[1, "股东会决议", "待取得"], [2, "章程修正案", "待取得"]] }] });
    const d1 = await r1.call("docx.render_report", { title: "交割备忘录", sections: [{ heading: "一、交割日", paragraphs: ["交割日为2026年11月30日。"] }] });

    // 第二轮（追问）：直接在第一轮的清单上改一格
    const t2 = await r2.call("xlsx.edit_cells", { artifact_version_id: t1.artifact_version_id, edits: [{ sheet: "先决条件", row: 1, column: "状态", value: "已取得" }] });
    assert.equal(t2.status, "applied", JSON.stringify(t2).slice(0, 300));
    assert.notEqual(t2.artifact_version_id, t1.artifact_version_id);
    assert.equal(rowOf(t2.artifact_version_id).run_id, r2.live.rid, "新版本登记在本轮任务下");
    assert.equal(rowOf(t2.artifact_version_id).filename, rowOf(t1.artifact_version_id).filename, "同名文件的新版本");
    const sheets = readCreatedXlsx(tk.kernel.blobs.read(rowOf(t2.artifact_version_id).storage_uri))!;
    assert.equal(sheets[0]!.rows[1]![2], "已取得");
    assert.equal(sheets[0]!.rows[2]![2], "待取得", "没改的行原样保留");
    // 第一轮的文件没有被改动
    assert.equal(readCreatedXlsx(tk.kernel.blobs.read(rowOf(t1.artifact_version_id).storage_uri))![0]!.rows[1]![2], "待取得");

    // 文书同理
    const d2 = await r2.call("docx.edit_draft", { artifact_version_id: d1.artifact_version_id, patches: [{ anchor: "交割日为2026年11月30日", proposed_text: "交割日为2026年12月1日" }] });
    assert.equal(d2.status, "applied", JSON.stringify(d2).slice(0, 300));
    assert.equal(rowOf(d2.artifact_version_id).run_id, r2.live.rid);
    assert.match((readZipText(tk.kernel.blobs.read(rowOf(d2.artifact_version_id).storage_uri), "word/document.xml") ?? "").replace(/<[^>]+>/g, ""), /交割日为2026年12月1日/);

    // 第三轮（再追问）：拿着第一轮的旧编号改——拒绝，并给出最新版编号；按最新版编号改成功
    for (const [name, oldId, latestId, args] of [
      ["xlsx.edit_cells", t1.artifact_version_id, t2.artifact_version_id, { edits: [{ sheet: "先决条件", row: 2, column: "状态", value: "已取得" }] }],
      ["docx.edit_draft", d1.artifact_version_id, d2.artifact_version_id, { patches: [{ anchor: "交割日为2026年12月1日", proposed_text: "交割日为2026年12月2日" }] }],
    ] as const) {
      const stale = await r3.raw(name, { artifact_version_id: oldId, ...args });
      assert.equal(stale.result?.isError, true, name);
      assert.match(JSON.stringify(stale), new RegExp(`已有更新的版本[^"]*请改用成果编号 ${latestId}`), `${name}: ${JSON.stringify(stale).slice(0, 400)}`);
      const ok = await r3.call(name, { artifact_version_id: latestId, ...args });
      assert.equal(ok.status, "applied", name);
      assert.equal(rowOf(ok.artifact_version_id).run_id, r3.live.rid);
    }
    // 本轮自己刚改出的版本可以接着改（不受“最新版”限制的影响）
    const mine = tk.kernel.db.get<{ artifact_version_id: string }>(`SELECT artifact_version_id FROM artifact_versions WHERE run_id = ? AND kind = 'agent_table' ORDER BY version DESC LIMIT 1`, [r3.live.rid])!.artifact_version_id;
    assert.equal((await r3.call("xlsx.edit_cells", { artifact_version_id: mine, edits: [{ sheet: "先决条件", row: 1, column: "事项", value: "股东会决议（含董事会改组）" }] })).status, "applied");

    // 不在这条追问链上的任务：照旧拒绝
    const x = await other.raw("xlsx.edit_cells", { artifact_version_id: t2.artifact_version_id, edits: [{ sheet: "先决条件", row: 1, column: "状态", value: "x" }] });
    assert.match(JSON.stringify(x), /只能修改本任务（含它所追问的此前各轮）里生成的表格/);
    const y = await other.raw("docx.edit_draft", { artifact_version_id: d2.artifact_version_id, patches: [{ anchor: "交割日", proposed_text: "x" }] });
    assert.match(JSON.stringify(y), /只能修改本任务（含它所追问的此前各轮）里生成的文书草稿/);

    // 追问提示里列的文件：此前各轮每份文件的最新版（不含本轮），带成果编号与该用的工具
    assert.deepEqual(followUpChain(tk.kernel.db, r3.live.rid), [r1.live.rid, r2.live.rid, r3.live.rid]);
    const targets = chainEditTargets(tk.kernel.db, [r1.live.rid, r2.live.rid], matter.matter_id);
    assert.deepEqual(targets.map((t) => [t.kind, t.artifact_version_id]).sort(), [["docx", d2.artifact_version_id], ["xlsx", t2.artifact_version_id]].sort());
    const line = followUpEditLine(targets);
    assert.match(line, /【此前交出的文件】这次只改其中几处的，直接在最新版上改，不要整份重出：/);
    assert.ok(line.includes(`——用 xlsx.edit_cells，成果编号 ${t2.artifact_version_id}`), line);
    assert.ok(line.includes(`——用 docx.edit_draft，成果编号 ${d2.artifact_version_id}`), line);
    assert.equal(followUpEditLine([]), "");
  } finally {
    for (const a of [r1, r2, r3, other]) await a.close();
  }
});
