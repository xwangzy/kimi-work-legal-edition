/**
 * V10 第 36 批真实走查 V9：律师要“加一条提前退租权”，助手把新的“2.3 ……”接在第 2.2 款的改字里换行写，
 * 修订稿里成了第 2.2 款段内的软回车——不受自动编号管理，与第 2.2 款的修改合成一处修订，对方没法单独拒绝。
 * 现在改字的新文字里换行后冒出新的条款编号的，退回并提示另提一条 insert_after。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createStyledDocx, extractParagraphs, readZipEntries } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { newClauseInEdit } from "../src/services/structured-patch.ts";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "revise-new-clause-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("改字的新文字换行后冒出新条款编号才算；原文里已有的编号、非编号的换行不算", () => {
  assert.equal(newClauseInEdit("2.2 逾期每日千分之三。", "2.2 逾期每日万分之五。\n2.3 工程提前完工的，乙方可退租。"), "2.3");
  assert.equal(newClauseInEdit("第六条 违约责任", "第六条 违约责任\n第七条 提前退租"), "第七条");
  assert.equal(newClauseInEdit("甲方：某某公司", "甲方：某某公司\n地址：某某路 1 号"), null);
  assert.equal(newClauseInEdit("按 2.3 款执行。", "按 2.3 款执行。\n2.3 款另有约定的除外。"), null, "原文里已有的编号");
  assert.equal(newClauseInEdit("第一行\n第二行", "第一行\n2.3 第二行"), null, "原文本身是多行段落的不查");
  assert.equal(newClauseInEdit("押金 50,000 元", "押金 82,000 元\n12.5 万元以下部分"), "12.5", "行首数字形如款号的也退回，由助手改写或拆开");
});

const p = (t: string) => ({ kind: "p" as const, runs: [{ text: t }] });

test("docx.revise：新条款接在改字里换行写的整体退回并给改法；拆成改字 + insert_after 后写成独立段落", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const contract = createStyledDocx(
    [
      { kind: "title", text: "设备租赁合同" },
      { kind: "h1", text: "第二条 租金" },
      p("2.1 租金按季度预付。"),
      p("2.2 乙方逾期支付租金的，每日按应付未付金额的千分之三支付违约金。"),
      { kind: "h1", text: "第三条 押金" },
      p("3.1 押金于租赁期满后返还。"),
    ],
    undefined,
    null,
    { mark: false },
  );
  const { matter } = await tk.inv("matters.create", { title: "租赁合同修订", stance: "承租人", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-03" } });
  const doc = await importBytes(tk.inv, matter.matter_id, "设备租赁合同（出租方提供稿）.docx", contract, DOCX_MIME);
  const live = liveTaskIdentity(tk, matter.matter_id, "v10_nc");
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
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r).slice(0, 400)}`);
    return r.result.structuredContent;
  };
  try {
    const anchor = "乙方逾期支付租金的，每日按应付未付金额的千分之三支付违约金。";
    const merged = { anchor, proposed_text: "乙方逾期支付租金的，每日按应付未付金额的万分之五支付违约金。\n2.3 工程提前完工的，乙方提前三十日书面通知即可退租。" };
    const bad = await call("docx.revise", { document_version_id: doc.document_version_id, patches: [merged] });
    assert.equal(bad.status, "not_applied");
    assert.equal(bad.conflicts?.[0]?.reason, "new_clause_in_edit", JSON.stringify(bad.conflicts));
    assert.match(bad.conflicts[0].fix, /insert_after/);

    const edit = { anchor, proposed_text: "乙方逾期支付租金的，每日按应付未付金额的万分之五支付违约金。" };
    const insert = { anchor, proposed_text: "工程提前完工的，乙方提前三十日书面通知即可退租。", insert_after: true };
    const ok = await call("docx.revise", { document_version_id: doc.document_version_id, patches: [edit, insert] });
    assert.equal(ok.status, "applied", JSON.stringify(ok).slice(0, 400));
    const art = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [ok.revision.artifact_version_id])!;
    const buf = tk.kernel.blobs.read(art.storage_uri);
    const texts = extractParagraphs(buf).map((x) => x.text);
    const at = texts.findIndex((t) => t.includes("工程提前完工的"));
    assert.ok(at > 0 && !texts[at]!.includes("万分之五"), "新条款是独立段落，不在第 2.2 款段内");
    assert.ok(!readZipEntries(buf).get("word/document.xml")!.toString("utf8").includes("<w:br/>"), "没有段内软回车");
  } finally {
    await agent.close();
  }
});
