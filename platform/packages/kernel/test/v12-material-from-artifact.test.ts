/**
 * V12 多轮修订：docx.revise 只认事项材料，第一轮的修订稿进不了第二轮——律师只能下载后重新上传，或在追问里让助手改原件（第一轮的修改丢失）。
 * materials.from_artifact 把修订稿 / 清洁稿 / 助手起草的 Word 作为新材料加入事项（还原真名、记来源、审计），第二轮在它上面写修订、第一轮修订保留。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createStyledDocx, extractParagraphs, readZipEntries } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "v12-from-artifact-firm");
});
after(async () => {
  await tk.kernel.close();
});

const p = (t: string) => ({ kind: "p" as const, runs: [{ text: t }] });

test("第一轮修订稿作为材料加入事项，第二轮在它上面修改：第一轮修订保留、真名还原、来源可查；非 Word 或非文书成果不收", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const contract = createStyledDocx([{ kind: "title", text: "设备采购合同" }, { kind: "h1", text: "第五条 违约责任" }, p("5.1 卖方逾期交付的，每日按万分之一支付违约金。"), p("5.2 买方联系人张伟负责验收。"), { kind: "h1", text: "第十条 争议解决" }, p("10.1 提交上海国际仲裁中心仲裁。")], undefined, null, { mark: false });
  const { matter } = await tk.inv("matters.create", { title: "多轮修订", stance: "买方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-04" } });
  const doc = await importBytes(tk.inv, matter.matter_id, "设备采购合同.docx", contract, DOCX_MIME);
  const live = liveTaskIdentity(tk, matter.matter_id, "v12_fa");
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await fetch("http://kernel.local/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r).slice(0, 400)}`);
    return r.result.structuredContent;
  };
  try {
    const r1 = await call("docx.revise", { document_version_id: doc.document_version_id, patches: [{ anchor: "每日按万分之一支付违约金。", proposed_text: "每日按万分之五支付违约金，累计不超过合同总价的百分之十。" }] });
    assert.equal(r1.status, "applied", JSON.stringify(r1).slice(0, 300));
    const m = await tk.inv("materials.from_artifact", { artifact_version_id: r1.revision.artifact_version_id });
    assert.equal(m.filename, "设备采购合同-第2轮.docx", "按轮次命名，不叠加“（修订稿）”");
    assert.equal(m.source_artifact_version_id, r1.revision.artifact_version_id);
    const row = tk.kernel.db.get<{ storage_uri: string; matter_id: string }>(`SELECT storage_uri, matter_id FROM document_versions WHERE document_version_id = ?`, [m.document_version_id])!;
    assert.equal(row.matter_id, matter.matter_id);
    const asMaterial = tk.kernel.blobs.read(row.storage_uri);
    const xml = readZipEntries(asMaterial).get("word/document.xml")!.toString("utf8");
    assert.ok(xml.includes("<w:ins "), "第一轮修订痕迹随底稿保留");
    assert.ok(!xml.includes("〔"), "材料存真名，不含代号");
    assert.ok(extractParagraphs(asMaterial).some((x) => x.text.includes("张伟")));

    // 第二轮在第一轮修订稿上改
    const r2 = await call("docx.revise", { document_version_id: m.document_version_id, patches: [{ anchor: "提交上海国际仲裁中心仲裁。", proposed_text: "提交杭州仲裁委员会仲裁，仲裁地杭州。" }] });
    assert.equal(r2.status, "applied", JSON.stringify(r2).slice(0, 300));
    const art2 = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [r2.revision.artifact_version_id])!;
    const xml2 = readZipEntries(tk.kernel.blobs.read(art2.storage_uri)).get("word/document.xml")!.toString("utf8");
    const t2 = extractParagraphs(tk.kernel.blobs.read(art2.storage_uri)).map((x) => x.text).join("\n");
    assert.ok(t2.includes("万分之五") && t2.includes("杭州仲裁委员会"), `两轮修改都在：${t2}`);
    assert.ok((xml2.match(/<w:ins /g) ?? []).length >= 2, "两轮修订痕迹都在");

    const clean = await tk.inv("materials.from_artifact", { artifact_version_id: r1.clean.artifact_version_id });
    assert.equal(clean.filename, "设备采购合同-第3轮.docx");
    await assert.rejects(tk.inv("materials.from_artifact", { artifact_version_id: "artv_nope" }));
  } finally {
    await agent.close();
  }
});
