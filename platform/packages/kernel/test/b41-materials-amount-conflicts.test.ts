/**
 * V16 第 41 批真实回归：调用 AI 的任务（精读整理案卷、争点分析、管辖与时效核查）拿不到整理案卷的确定性金额比对——
 * 三个真实任务都漏了催款函“大写肆拾伍万伍仟元整 / 小写 ¥445,000.00”，其中一个还写了“金额一致，未发现算术冲突”。
 * materials.list 在每份材料上带出大写与小写对不上的各处，顶层带出不同材料对同一天付款写的不同金额（与整理案卷同一套规则）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { importText, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b41-mat-amounts-firm");
});
after(async () => {
  await tk.kernel.close();
});

async function listFor(title: string, docs: [string, string][]) {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title, stance: "原告", consent_status: "agreed" });
  const ids: string[] = [];
  for (const [name, text] of docs) ids.push((await importText(tk.inv, matter.matter_id, name, text)).document_version_id);
  const live = liveTaskIdentity(tk, matter.matter_id, title.slice(0, 6));
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "精读", document_version_ids: ids }), live.rid]);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  const res = (await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "materials.list", arguments: {} } }), dispatcher: agent }).then((x) => x.json())) as any;
  return res.result.structuredContent;
}

test("materials.list：一份材料内大写与小写不一致、两份材料对同一天付款写不同金额，都带出来；顶层说明不许写成“金额一致”", { timeout: 60_000 }, async () => {
  const r = await listFor("金额比对", [
    ["06-催款函.txt", "贵司尚欠我司货款人民币肆拾伍万伍仟元整（¥445,000.00），请于收函后七日内付清。贵司已于2026年3月10日支付货款200,000元。"],
    ["04-对账确认函.txt", "经核对，贵司于2026年3月10日支付货款300,000元。"],
  ]);
  const letter = r.materials.find((m: any) => m.filename === "06-催款函.txt");
  const recon = r.materials.find((m: any) => m.filename === "04-对账确认函.txt");
  assert.deepEqual(letter.amount_conflicts, [{ upper: { text: "人民币肆拾伍万伍仟元整", amount_yuan: 455000 }, lower: { text: "¥445,000.00", amount_yuan: 445000 } }], JSON.stringify(letter));
  assert.equal("amount_conflicts" in recon, false, "没有冲突的材料不带这个字段");
  assert.equal(r.cross_material_conflicts.length, 1, JSON.stringify(r.cross_material_conflicts));
  const c = r.cross_material_conflicts[0];
  assert.equal(c.date, "2026-03-10");
  assert.deepEqual(c.amounts.map((x: any) => [x.amount_yuan, x.filenames]).sort(), [[200000, ["06-催款函.txt"]], [300000, ["04-对账确认函.txt"]]]);
  assert.match(r.note, /系统按规则比出来的，只覆盖这两类/);
  assert.match(r.note, /不要写“金额一致”/);
  assert.match(r.note, /不照抄/);
});

test("materials.list：没有冲突时不带 amount_conflicts 与 cross_material_conflicts", { timeout: 60_000 }, async () => {
  const r = await listFor("金额相符", [
    ["01-合同.txt", "合同总价人民币壹拾万元整（小写：100,000元）。买方于2026年3月10日支付100,000元。"],
    ["02-收款记录.txt", "2026年3月10日收到货款100,000元。"],
  ]);
  for (const m of r.materials) assert.equal("amount_conflicts" in m, false, JSON.stringify(m));
  assert.equal("cross_material_conflicts" in r, false, JSON.stringify(r));
});
