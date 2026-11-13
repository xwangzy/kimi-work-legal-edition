/**
 * V14 第 39 批：多轮修订——把本事项的 Word 成果作为新材料（materials.from_artifact）。
 * V13 W7 真实走查：第二轮修订只能在原件上把两轮修改合并重做，产品自己出的修订稿 / 清洁稿不能直接作下一轮底稿，
 * 律师只能下载后再上传（还原真名、记来源都靠人）。这里验证：成果按下载同一规则还原真名后登记为独立的新材料，
 * 原件与成果都不变；新材料能被 docx.revise 当原件再修订；非 Word 成果不收；审计记来源成果。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, readZipText } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b39-a2m-firm");
});
after(async () => {
  await tk.kernel.close();
});

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const text = (b: Buffer) => (readZipText(b, "word/document.xml") ?? "").replace(/<[^>]+>/g, "");

test("修订稿作新材料：真名还原、独立登记、原件与成果不变；新材料可再用 docx.revise 修订（第二轮）", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "服务合同修订", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-09" } });
  await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "何予安", kind: "person" });
  const original = createDocx("服务合同", [{ heading: "第一条 价款", paragraphs: ["1.1 甲方法定代表人何予安确认，服务费为人民币100万元。", "1.2 乙方应于收款后开具发票。"] }], { mark: false });
  const doc = await importBytes(tk.inv, matter.matter_id, "服务合同.docx", original, DOCX);
  const live = liveTaskIdentity(tk, matter.matter_id, "a2m");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "按意见修改", document_version_ids: [doc.document_version_id] }), live.rid]);
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
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r)}`);
    return r.result.structuredContent;
  };
  // 第一轮：100 万 → 120 万
  const r1 = await call("docx.revise", { document_version_id: doc.document_version_id, patches: [{ anchor: "服务费为人民币100万元", proposed_text: "服务费为人民币120万元" }] });
  assert.equal(r1.status, "applied");
  const cleanBefore = tk.kernel.db.get<{ sha256: string }>(`SELECT sha256 FROM artifact_versions WHERE artifact_version_id = ?`, [r1.clean.artifact_version_id])!.sha256;

  // 清洁稿作为新材料
  const m = await tk.inv("materials.from_artifact", { artifact_version_id: r1.clean.artifact_version_id });
  assert.notEqual(m.document_version_id, doc.document_version_id, "独立的新材料，不覆盖原件");
  assert.match(m.filename, /^服务合同（第1轮修改后）\.docx$/, m.filename);
  const row = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM document_versions WHERE document_version_id = ?`, [m.document_version_id])!;
  const imported = text(tk.kernel.blobs.read(row.storage_uri));
  assert.match(imported, /何予安确认，服务费为人民币120万元/, "材料是第一轮修改后的文字、真名已还原");
  assert.equal(/〔自然人/.test(imported), false, "材料里没有代号");
  assert.equal(tk.kernel.db.get<{ sha256: string }>(`SELECT sha256 FROM artifact_versions WHERE artifact_version_id = ?`, [r1.clean.artifact_version_id])!.sha256, cleanBefore, "成果不变");
  const origRow = tk.kernel.db.get<{ superseded_by: string | null }>(`SELECT * FROM document_versions WHERE document_version_id = ?`, [doc.document_version_id]) as any;
  assert.ok(origRow, "原件仍在");
  const aud = tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'materials.from_artifact' AND object_id = ?`, [m.document_version_id])!;
  assert.equal(aud.n, 1, "审计记了一条");

  // 第二轮：在新材料上再改（修订痕迹以第一轮结果为底稿）。产品里“作为底稿继续修改”是另起一个任务并勾上这份新材料；
  // 这里沿用同一个任务身份，把勾选换成新材料（V18 第 43 批：勾选的材料就是任务的边界，没勾的不能修订）
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "按意见修改", document_version_ids: [m.document_version_id] }), live.rid]);
  const r2 = await call("docx.revise", { document_version_id: m.document_version_id, patches: [{ anchor: "乙方应于收款后开具发票", proposed_text: "乙方应于收款后五个工作日内开具增值税专用发票" }] });
  assert.equal(r2.status, "applied", JSON.stringify(r2));
  const rev2 = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [r2.revision.artifact_version_id])!;
  const xml = readZipText(tk.kernel.blobs.read(rev2.storage_uri), "word/document.xml") ?? "";
  assert.match(xml.replace(/<[^>]+>/g, ""), /服务费为人民币120万元/, "第一轮的结果在第二轮修订稿里是正文");
  assert.equal((xml.match(/<w:ins\b/g) ?? []).length >= 1, true, "第二轮修改以修订痕迹显示");
  assert.equal(/100万元/.test(xml.replace(/<w:delText[^>]*>[^<]*<\/w:delText>/g, "").replace(/<[^>]+>/g, "")), false, "第二轮修订稿里不再出现第一轮删掉的 100 万");
  // 文件名分得清轮次：第二轮成果是“服务合同（第1轮修改后）（修订稿）”；再往下一轮，底稿叫“第2轮修改后”
  const r2name = tk.kernel.db.get<{ filename: string }>(`SELECT filename FROM artifact_versions WHERE artifact_version_id = ?`, [r2.revision.artifact_version_id])!.filename;
  assert.equal(r2name, "服务合同（第1轮修改后）（修订稿）.docx");
  const m3 = await tk.inv("materials.from_artifact", { artifact_version_id: r2.clean.artifact_version_id });
  assert.equal(m3.filename, "服务合同（第2轮修改后）.docx");
});

test("非 Word 成果不能作为材料", async () => {
  const { matter } = await tk.inv("matters.create", { title: "表格", stance: "原告", consent_status: "agreed" });
  const live = liveTaskIdentity(tk, matter.matter_id, "a2mx");
  const id = "artv_b39x";
  const stored = tk.kernel.blobs.put(Buffer.from("# 说明\n", "utf8"), matter.matter_id);
  tk.kernel.db.run(
    `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by)
     VALUES (?,?,?,?,'a1_agent_draft',1,'internal','draft','说明.md',?,?,'[]','{}',?)`,
    [id, live.tid, matter.matter_id, live.rid, stored.sha256, stored.storage_uri, live.uid],
  );
  await assert.rejects(tk.inv("materials.from_artifact", { artifact_version_id: id }), /只有 Word 成果/);
});

test("docx.compare 可以拿原件对本事项的清洁稿：助手交付前能核对实际写入的结果；别的事项的成果仍是“不存在”", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "比对清洁稿", stance: "委托方", consent_status: "agreed" });
  const original = createDocx("服务合同", [{ heading: "第一条 价款", paragraphs: ["1.1 服务费为人民币100万元。", "1.2 乙方应于收款后开具发票。"] }], { mark: false });
  const doc = await importBytes(tk.inv, matter.matter_id, "服务合同.docx", original, DOCX);
  const live = liveTaskIdentity(tk, matter.matter_id, "cmp");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "改", document_version_ids: [doc.document_version_id] }), live.rid]);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const raw = (name: string, args: unknown) =>
    fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }), dispatcher: agent }).then((x) => x.json()) as Promise<any>;
  const r1 = (await raw("docx.revise", { document_version_id: doc.document_version_id, patches: [{ anchor: "服务费为人民币100万元", proposed_text: "服务费为人民币120万元" }] })).result.structuredContent;
  assert.match(r1.note, /docx\.compare/, "写入成功的说明里告诉助手怎么核对");
  const cmp = await raw("docx.compare", { baseline_document_version_id: doc.document_version_id, current_document_version_id: r1.clean.artifact_version_id });
  assert.equal(cmp.result?.isError, false, JSON.stringify(cmp));
  const changes = cmp.result.structuredContent.changes as any[];
  assert.equal(changes.length, 1, JSON.stringify(changes));
  assert.match(JSON.stringify(changes[0]), /120万元/);
  // 别的事项的成果：照旧“不存在”
  const other = await tk.inv("matters.create", { title: "别的事项", stance: "原告", consent_status: "agreed" });
  const otherDoc = await importBytes(tk.inv, other.matter.matter_id, "x.docx", original, DOCX);
  const live2 = liveTaskIdentity(tk, other.matter.matter_id, "cmp2");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "改", document_version_ids: [otherDoc.document_version_id] }), live2.rid]);
  const token2 = mintTaskToken({ tid: live2.tid, uid: live2.uid, mid: live2.mid, rid: live2.rid, aid: live2.aid, fen: live2.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const cross = (await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token2}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "docx.compare", arguments: { baseline_document_version_id: otherDoc.document_version_id, current_document_version_id: r1.clean.artifact_version_id } } }), dispatcher: agent }).then((x) => x.json())) as any;
  assert.equal(cross.result?.isError, true);
  assert.match(cross.result.content[0].text, /not_found/);
});
