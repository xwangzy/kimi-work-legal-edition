/**
 * V14 第 39 批（基线走查 A 独立评分）：独立复核后的修改轮把第 10.3 条改完，同一项通知义务写了两遍（V13 W4 同类：v5 多出一整句）。
 * docx.edit_draft 写入后核对：修改后出现次数比修改前多、且出现两次以上的句子，退回给助手处理。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { newlyRepeatedSentences } from "../src/tools/tools/edit-draft.ts";

test("纯函数：修改后新增的重复句被找出；原本就重复的、太短的不报", () => {
  const before = ["10.3 乙方收货时应核对产品名称、规格、批号与数量，发现异常应当场在签收单上注明。", "价款：100万元；价款：100万元。"];
  const after = ["10.3 乙方收货时应核对产品名称、规格、批号与数量，发现异常应当场在签收单上注明；乙方收货时应核对产品名称、规格、批号与数量，发现异常应当场在签收单上注明。", "价款：100万元；价款：100万元。"];
  const r = newlyRepeatedSentences(before, after);
  assert.equal(r.length, 1);
  assert.match(r[0]!, /发现异常应当场在签收单上注明/);
  assert.deepEqual(newlyRepeatedSentences(before, before), [], "没改就不报；原本就重复的短句不报");
});

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b39-edit-repeat-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("edit_draft 改出重复句：照常写入新版本，结果里列出 repeated_sentences 并提示删掉一处", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "重复句", stance: "卖方", consent_status: "agreed" });
  const live = liveTaskIdentity(tk, matter.matter_id, "b39_rep");
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) => ((await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }), dispatcher: agent }).then((x) => x.json())) as any).result.structuredContent;
  const r1 = await call("docx.render_report", { title: "经销协议", sections: [{ heading: "第十条 交付", paragraphs: ["10.3 乙方收货时应核对产品名称、规格、批号与数量，发现异常应当场在签收单上注明。", "10.4 风险自签收时转移。"] }] });
  const r2 = await call("docx.edit_draft", { artifact_version_id: r1.artifact_version_id, patches: [{ anchor: "10.4 风险自签收时转移。", proposed_text: "10.4 乙方收货时应核对产品名称、规格、批号与数量，发现异常应当场在签收单上注明。风险自签收时转移。" }] });
  assert.equal(r2.status, "applied", JSON.stringify(r2));
  assert.equal(r2.repeated_sentences?.length, 1, JSON.stringify(r2));
  assert.match(r2.repeated_note, /删掉一处/);
  // 正常修改不报
  const r3 = await call("docx.edit_draft", { artifact_version_id: r1.artifact_version_id, patches: [{ anchor: "风险自签收时转移", proposed_text: "货物毁损灭失的风险自乙方签收时转移" }] });
  assert.equal(r3.repeated_sentences, undefined);
});
