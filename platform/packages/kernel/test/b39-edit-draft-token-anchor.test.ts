/**
 * V14 第 39 批真实走查 A（独家经销协议，K3.1-Pro）：法条原文“当事人一方明确表示”让“方明”被认成姓名学进令牌表；
 * 助手早先写进《起草说明》的“卖方明知”在回读里成了“卖〔自然人·…〕知”，修改轮照抄回读的锚点 9 次 edit_draft 都定位不到，
 * 最后只能请律师同意整份重出。草稿里是原字、回读里是代号时，锚点里的代号换回原字再找一次。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readZipText } from "@zr-legal/docx-engine";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b39-edit-token-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("锚点里的代号在草稿里是原字（令牌表后来学进的值）：换回原字定位并写入", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "代号锚点", stance: "卖方", consent_status: "agreed" });
  const live = liveTaskIdentity(tk, matter.matter_id, "b39_tok");
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) => ((await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }), dispatcher: agent }).then((x) => x.json())) as any).result.structuredContent;
  const r1 = await call("docx.render_report", { title: "起草说明", sections: [{ heading: "一、交付与验收", paragraphs: ["短期异议主要适用于可通过收货检验发现的事项，不能排除卖方明知产品不合格等法定责任。"] }] });
  assert.ok(r1.artifact_version_id, JSON.stringify(r1));
  // 之后“方明”被学进令牌表（真实走查里来自法条原文）
  const tok = "〔自然人·TQ3B7K〕";
  tk.kernel.db.run(`INSERT INTO matter_tokens (matter_id, token, category, value, normalized, source) VALUES (?,?,?,?,?,?)`, [matter.matter_id, tok, "person", "方明", "方明", "recognizer"]);
  const r2 = await call("docx.edit_draft", { artifact_version_id: r1.artifact_version_id, patches: [{ anchor: `不能排除卖${tok}知产品不合格等法定责任`, proposed_text: "不能排除甲方知道或者应当知道产品不合格等法定责任" }] });
  assert.equal(r2.status, "applied", JSON.stringify(r2));
  const row = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [r2.artifact_version_id])!;
  const text = (readZipText(tk.kernel.blobs.read(row.storage_uri), "word/document.xml") ?? "").replace(/<[^>]+>/g, "");
  assert.match(text, /不能排除甲方知道或者应当知道产品不合格/);
  assert.equal(text.includes("〔自然人"), false);
  // 草稿里本来就没有的文字照旧退回
  const r3 = await call("docx.edit_draft", { artifact_version_id: r2.artifact_version_id, patches: [{ anchor: `${tok}确认收货`, proposed_text: "x" }] });
  assert.equal(r3.status, "not_applied");
  assert.equal(r3.conflicts[0].reason, "anchor_not_found");
});
