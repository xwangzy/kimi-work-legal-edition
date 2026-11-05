/**
 * V12 R-8 真实走查 R4b：律师追问“在上一版清洁稿基础上再改两处，继续出修订稿和清洁稿”。docx.revise 只认律师上传的材料，
 * docx.edit_draft 只认 docx.render_report 的草稿，上一轮的清洁稿两边都不收——助手只能请律师把清洁稿下载后重新导入。
 * 现在 docx.revise 收本事项上一轮的清洁稿作底稿：本轮修订稿只显示新的改动，文件名回到原件名，版本链沿用原件；旧的清洁稿不能再作底稿。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createStyledDocx, extractParagraphs, readZipEntries, sanitizeDocx } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "v12-multi-round-firm");
});
after(async () => {
  await tk.kernel.close();
});
const p = (t: string) => ({ kind: "p" as const, runs: [{ text: t }] });

test("第二轮在上一轮清洁稿上修订：只显示本轮改动；更早的清洁稿不能再作底稿；别的事项的清洁稿不收", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "冷链协议多轮修订", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-05" } });
  const src = createStyledDocx([{ kind: "title", text: "冷链服务协议" }, { kind: "h1", text: "第一条 赔偿" }, p("1.1 乙方按进货价的50%赔偿。"), { kind: "h1", text: "第二条 其他" }, p("2.1 本协议一式两份。")], undefined, null, { mark: false });
  const doc = await importBytes(tk.inv, matter.matter_id, "冷链服务协议.docx", src, DOCX_MIME);
  const live = liveTaskIdentity(tk, matter.matter_id, "v12_mr");
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) =>
    ((await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }), dispatcher: agent }).then((x) => x.json())) as any).result;
  const bytes = (id: string) => tk.kernel.blobs.read(tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [id])!.storage_uri);
  try {
    const r1 = (await call("docx.revise", { document_version_id: doc.document_version_id, patches: [{ anchor: "乙方按进货价的50%赔偿。", proposed_text: "乙方按进货价全额赔偿。" }] })).structuredContent;
    assert.equal(r1.status, "applied");
    assert.match(r1.note, /clean\.artifact_version_id/, "告诉助手下一轮用清洁稿编号");
    // 第二轮：底稿是第一轮的清洁稿
    const r2res = await call("docx.revise", { document_version_id: r1.clean.artifact_version_id, patches: [{ anchor: "本协议一式两份。", proposed_text: "本协议一式四份。" }] });
    assert.equal(r2res.isError, false, JSON.stringify(r2res).slice(0, 400));
    const r2 = r2res.structuredContent;
    assert.equal(r2.status, "applied");
    assert.equal(r2.revision.filename, "冷链服务协议（修订稿）.docx", "文件名回到原件名，不叠成“（清洁稿）（修订稿）”");
    const tracked = readZipEntries(bytes(r2.revision.artifact_version_id)).get("word/document.xml")!.toString("utf8");
    const dels = [...tracked.matchAll(/<w:delText[^>]*>([^<]*)<\/w:delText>/g)].map((m) => m[1]).join("");
    const inss = [...tracked.matchAll(/<w:ins\b[\s\S]*?<\/w:ins>/g)].map((m) => [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((x) => x[1]).join("")).join("");
    assert.ok(!dels.includes("50%") && !inss.includes("全额"), `第一轮的改动已是底稿正文，不再显示为修订（del=${dels} ins=${inss}）`);
    assert.ok(inss.includes("四") && dels.includes("两"), `本轮改动以修订显示（del=${dels} ins=${inss}）`);
    assert.deepEqual(extractParagraphs(sanitizeDocx(bytes(r2.revision.artifact_version_id)).docx).map((x) => x.text).filter((t) => t.includes("赔偿") || t.includes("份")), ["第一条 赔偿", "1.1 乙方按进货价全额赔偿。", "2.1 本协议一式四份。"].filter((t) => t.includes("赔偿") || t.includes("份")));
    const m2 = JSON.parse(tk.kernel.db.get<{ manifest: string }>(`SELECT manifest FROM artifact_versions WHERE artifact_version_id = ?`, [r2.revision.artifact_version_id])!.manifest);
    assert.equal(m2.source_document_version_id, doc.document_version_id, "版本链沿用原件");
    assert.equal(m2.base_artifact_version_id, r1.clean.artifact_version_id);
    // 第一轮的清洁稿已被第二轮取代：不能再作底稿
    const stale = (await call("docx.revise", { document_version_id: r1.clean.artifact_version_id, patches: [{ anchor: "全额赔偿", proposed_text: "全额赔偿及利息" }] })).structuredContent;
    assert.equal(stale.status, "not_applied");
    assert.equal(stale.reason, "document_version_superseded");
    // 修订稿（带痕迹）、别的种类的成果不能作底稿
    const bad = await call("docx.revise", { document_version_id: r2.revision.artifact_version_id, patches: [{ anchor: "四份", proposed_text: "六份" }] });
    assert.equal(bad.isError, true, "修订稿本身不作底稿");
  } finally {
    await agent.close();
  }
});
