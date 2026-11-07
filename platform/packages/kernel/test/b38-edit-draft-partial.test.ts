/**
 * V13 第 38 批：docx.edit_draft 能定位的先写入、定位不到的逐条退回。
 * 取证（安全日志 TOOLS_DOCX_EDIT_OUTCOME，真实走查 W1、W2）：4 次正式调用里 2 次是“2 处中 1 处找不到”而整体未写，另一处本可写入，助手只能整组重提。
 * 草稿是在最新版本上逐处增量修改，部分写入不会丢掉已写的修改；docx.revise（每次在原件上重做全部修改）仍是整体写入。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { extractParagraphs } from "@zr-legal/docx-engine";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b38-edit-partial-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("两处里一处找不到：找得到的写入新版本（status=partial），找不到的退回原因；再用新编号只重交那一处", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "部分写入", stance: "买方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-07" } });
  const live = liveTaskIdentity(tk, matter.matter_id, "b38_partial");
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) => {
    const r = (await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }), dispatcher: agent }).then((x) => x.json())) as any;
    assert.equal(r.result?.isError, false, JSON.stringify(r).slice(0, 400));
    return r.result.structuredContent;
  };
  try {
    const r1 = await call("docx.render_report", { title: "设备买卖合同", sections: [{ heading: "第一条 价款", paragraphs: ["1.1 价款为人民币100万元。", "1.2 买方于验收合格后10日内付款。"] }] });
    const r2 = await call("docx.edit_draft", { artifact_version_id: r1.artifact_version_id, patches: [{ anchor: "价款为人民币100万元", proposed_text: "价款为人民币120万元" }, { anchor: "草稿里没有的一句话", proposed_text: "x" }] });
    assert.equal(r2.status, "partial", JSON.stringify(r2));
    assert.equal(r2.applied, 1);
    assert.deepEqual(r2.conflicts.map((c: any) => [c.index, c.reason]), [[1, "anchor_not_found"]]);
    assert.match(r2.note, /只重交这几处/);
    assert.notEqual(r2.artifact_version_id, r1.artifact_version_id);
    const r3 = await call("docx.edit_draft", { artifact_version_id: r2.artifact_version_id, patches: [{ anchor: "验收合格后10日内", proposed_text: "验收合格后15日内" }] });
    assert.equal(r3.status, "applied");
    const dl = Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: r3.artifact_version_id })).data_base64, "base64");
    const all = extractParagraphs(dl).map((x) => x.text).join("\n");
    assert.ok(all.includes("价款为人民币120万元") && all.includes("验收合格后15日内"), all);
  } finally {
    await agent.close();
  }
});
