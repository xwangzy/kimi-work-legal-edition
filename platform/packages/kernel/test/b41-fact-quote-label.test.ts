/**
 * V16 第 41 批真实回归：给助手读的材料文字里，Word 自动编号的条款带着编号（“2.1 卖方应于…”“4.2 设备验收合格之日起…”），
 * 助手照抄进 facts.submit 的 quote；定位视图是 Word 段落原文、不含自动编号——整批合同条款事实定位不到（anchor_status = not_found），
 * 又重复提交一遍，时间线里成对重复。整句找不到时去掉开头的条款编号再找，锚点落在正文上。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { locateQuote, stripLeadingClauseNo } from "../src/services/review-cards.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const SAMPLE = fileURLToPath(new URL("../../../apps/desktop/kwl-testdocs/V14/L1/01-设备买卖合同（RC-XS-2025-118）.docx", import.meta.url));

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b41-fact-label-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("去掉引文开头的条款编号：各种写法；紧接数额、日期的数字不当编号；去掉后不足 6 个字不放宽", () => {
  for (const [q, want] of [
    ["2.1 卖方应于2025年10月31日前交付", "卖方应于2025年10月31日前交付"],
    ["2.1卖方应于2025年10月31日前交付", "卖方应于2025年10月31日前交付"],
    ["第十二条 争议由买方住所地法院管辖", "争议由买方住所地法院管辖"],
    ["第3条　争议由买方住所地法院管辖", "争议由买方住所地法院管辖"],
    ["（三）买方逾期付款的违约责任", "买方逾期付款的违约责任"],
    ["3. 买方逾期付款的违约责任", "买方逾期付款的违约责任"],
    ["一、买方逾期付款的违约责任", "买方逾期付款的违约责任"],
    ["4.2.1 设备验收合格之日起30日内", "设备验收合格之日起30日内"],
  ] as const) assert.equal(stripLeadingClauseNo(q), want, q);
  for (const q of ["2.1万元由买方于验收后支付", "2025年10月31日前卖方交付设备", "3.5%的违约金按日计算", "4.2", "2.1 卖方交付", "第一期 | 300,000 元"]) assert.equal(stripLeadingClauseNo(q), q, q);
  const view = "卖方应于2025年10月31日前将设备送至买方工厂。\n设备验收合格之日起30日内，买方支付合同总价的60%。";
  const loc = locateQuote(view, "4.2 设备验收合格之日起30日内，买方支付合同总价的60%。");
  assert.equal(loc.status, "located");
  assert.equal(view.slice(loc.start!, loc.end!), "设备验收合格之日起30日内，买方支付合同总价的60%。", "锚点落在正文上，不含编号");
  assert.equal(locateQuote(view, "4.2 卖方应于").status, "not_found", "去掉编号后不足 6 个字不放宽");
});

test("带自动编号的真实合同：助手照抄“编号 + 正文”作 quote 提交事实，定位到正文", { timeout: 60_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "事实引文带编号", stance: "卖方", consent_status: "agreed" });
  const doc = await importBytes(tk.inv, matter.matter_id, "设备买卖合同.docx", readFileSync(SAMPLE), DOCX);
  const live = liveTaskIdentity(tk, matter.matter_id, "label");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "整理", document_version_ids: [doc.document_version_id] }), live.rid]);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) => ((await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }), dispatcher: agent }).then((x) => x.json())) as any).result.structuredContent;
  // 助手读到的材料文字：条款带着自动编号
  const ex = await call("materials.read_excerpt", { parse_version_id: (await call("materials.list", {})).materials[0].parse_version_id });
  const line = (prefix: string) => String(ex.text).split("\n").find((l: string) => l.startsWith(prefix))!;
  const l21 = line("2.1 卖方应于");
  const l42 = line("4.2 设备验收合格之日起");
  assert.ok(l21 && l42, "材料文字里条款带编号");
  const q21 = l21.slice(0, 40);
  const q42 = l42.trim();
  const r = await call("facts.submit", {
    facts: [
      { statement: "卖方应于2025-10-31前送货至买方工厂", kind: "claimed", occurred_on: "2025-10-31", document_version_id: doc.document_version_id, quote: q21 },
      { statement: "验收合格之日起30日内买方支付合同总价的60%", kind: "claimed", document_version_id: doc.document_version_id, quote: q42 },
      { statement: "只有编号的引文", kind: "claimed", document_version_id: doc.document_version_id, quote: "4.2" },
    ],
  });
  assert.equal(r.submitted, 3, JSON.stringify(r));
  const rows = tk.kernel.db.all<{ quote: string; anchor_status: string; anchor_start: number | null; anchor_end: number | null }>(`SELECT quote, anchor_status, anchor_start, anchor_end FROM matter_facts WHERE matter_id = ? ORDER BY seq`, [matter.matter_id]);
  assert.deepEqual(rows.map((x) => x.anchor_status), ["located", "located", "not_found"], JSON.stringify(rows));
  // 锚点落在正文上（不含编号）：锚点长度等于去掉“4.2 ”后的正文长度
  const body = q42.replace(/^4\.2\s*/, "");
  assert.equal(rows[1]!.anchor_end! - rows[1]!.anchor_start!, body.length);
});
