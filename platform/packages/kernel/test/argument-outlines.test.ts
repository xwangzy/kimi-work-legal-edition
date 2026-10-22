/**
 * v9.4 第 19 批 C-04（评审 C1 §1、§4）：起草前“论点与依据”确认——Agent 经本机端点调用 outline.submit / outline.get；
 * 依据离线核验并附法规库条文原文；事实引用核对是否律师已确认；律师在任务页逐条留 / 删 / 改写、去掉不用的依据；
 * 确认之前本任务不能生成文书（docx.render_report 拒绝），确认后 outline.get 只给确认版；结果交回 Agent 前令牌化。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { LEGAL_MCP_TOOLS } from "@zr-legal/domain";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { findTool, legalToolLockProblems } from "../src/tools/registry.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "outline-firm");
});
after(async () => {
  await tk.kernel.close();
});

async function agentFor(matterId: string, label: string) {
  const { Agent, fetch } = await import("undici");
  const live = liveTaskIdentity(tk, matterId, label);
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
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r)}`);
    assert.equal(JSON.stringify(r).includes("李娜"), false, `${name} 的结果交回 Agent 前须令牌化`);
    return r.result.structuredContent;
  };
  return { live, raw, call, close: () => agent.close() };
}

test("工具已登记、锁文件一致、对 Agent 开放", () => {
  for (const n of ["outline.submit", "outline.get"]) {
    assert.ok((LEGAL_MCP_TOOLS as readonly string[]).includes(n));
    assert.ok(findTool(n));
  }
  for (const n of ["outline.submit", "outline.get", "docx.render_report"]) assert.equal(legalToolLockProblems().has(n), false, `${n}: ${legalToolLockProblems().get(n)}`);
});

test("提交 → 文书被挡 → 律师逐条确认（删一条、改写一条、去掉一条依据）→ 读到确认版 → 可以出文书", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "买卖合同纠纷", stance: "原告", consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-01" } });
  await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "李娜", kind: "person" });
  const a = await agentFor(matter.matter_id, "outline");
  // 一条律师已确认的事实、一条待确认的事实
  tk.kernel.db.run(`INSERT INTO matter_facts (fact_id, tenant_id, matter_id, run_id, seq, statement, kind, anchor_status, status) VALUES ('fct_ok', ?, ?, ?, 1, '被告于 2026 年 3 月 1 日签收货物', 'confirmed', 'no_document', 'confirmed')`, [a.live.tid, matter.matter_id, a.live.rid]);
  tk.kernel.db.run(`INSERT INTO matter_facts (fact_id, tenant_id, matter_id, run_id, seq, statement, kind, anchor_status, status) VALUES ('fct_open', ?, ?, ?, 2, '被告至今未付款', 'claimed', 'no_document', 'proposed')`, [a.live.tid, matter.matter_id, a.live.rid]);

  const sub = await a.call("outline.submit", {
    doc_kind: "起诉状",
    arguments: [
      { claim: "被告应支付货款", basis: [{ law: "中华人民共和国民法典", article: 509, note: "全面履行义务" }, { law: "民法典", article: 585, note: "违约金" }], facts: [{ fact_id: "fct_ok" }, { fact_id: "fct_open" }] },
      { claim: "被告应承担违约金", basis: [{ law: "民法典", article: 585, note: "约定违约金" }] },
      { claim: "被告应赔偿律师费", basis: [{ law: "宇宙条约", article: 1 }], counter: "律师费须有约定" },
    ],
  });
  assert.equal(sub.status, "proposed");
  assert.deepEqual(sub.arguments.map((x: any) => x.basis_with_text), [2, 1, 0], "库内条文附原文，库外没有");
  assert.equal(sub.arguments[2].basis_checks[0], "intercepted", "库外法源如实拦截");
  assert.equal(sub.arguments[0].unconfirmed_facts, 1);
  assert.match(sub.note, /intercepted/);

  // 确认之前：读不到确认版、不能出文书
  assert.equal((await a.call("outline.get", {})).status, "proposed");
  const blocked = await a.raw("docx.render_report", { title: "起诉状", sections: [{ heading: "诉讼请求", paragraphs: ["一、判令被告支付货款"] }] });
  assert.equal(blocked.result?.isError, true);
  assert.match(JSON.stringify(blocked), /论点与依据还在等律师确认/);

  // 界面接口：看得到条文原文与事实是否确认
  const ui = (await tk.inv("outlines.list", { matter_id: matter.matter_id, run_id: a.live.rid })).outlines;
  assert.equal(ui.length, 1);
  assert.match(ui[0].items[0].basis[0].article_text, /当事人应当按照约定全面履行自己的义务/);
  assert.deepEqual(ui[0].items[0].facts.map((f: any) => f.confirmed), [true, false]);
  // 至少留一条
  await assert.rejects(tk.inv("outlines.decide", { matter_id: matter.matter_id, outline_id: sub.outline_id, decisions: ["a1", "a2", "a3"].map((id) => ({ arg_id: id, keep: false })) }), /至少留一条/);
  const dec = await tk.inv("outlines.decide", {
    matter_id: matter.matter_id,
    outline_id: sub.outline_id,
    decisions: [
      { arg_id: "a1", keep: true, basis_keep: [0] },
      { arg_id: "a2", keep: true, claim: "被告应按日万分之五支付逾期付款违约金（李娜代理意见）" },
      { arg_id: "a3", keep: false },
    ],
    note: "违约金按合同第 8.2 条计算",
  });
  assert.equal(dec.outline.status, "confirmed");
  await assert.rejects(tk.inv("outlines.decide", { matter_id: matter.matter_id, outline_id: sub.outline_id, decisions: [] }), /已确认/);

  const got = await a.call("outline.get", {});
  assert.equal(got.status, "confirmed");
  assert.deepEqual(got.confirmed_arguments.map((x: any) => x.arg_id), ["a1", "a2"]);
  assert.deepEqual(got.dropped, ["a3"]);
  assert.deepEqual(got.confirmed_arguments[0].basis.map((b: any) => b.article), [509], "去掉的依据不给");
  assert.equal(got.confirmed_arguments[1].lawyer_edited, true);
  assert.match(got.confirmed_arguments[1].claim, /〔自然人/, "律师改写里的姓名交回 Agent 前换成代号");
  assert.equal(got.lawyer_note, "违约金按合同第 8.2 条计算");
  const ok = await a.call("docx.render_report", { title: "起诉状", sections: [{ heading: "诉讼请求", paragraphs: ["一、判令被告支付货款"] }] });
  assert.match(ok.artifact_version_id, /^artv_/);
  // 审计只记计数
  const aud = tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'outline.confirmed' AND object_id = ?`, [sub.outline_id])!;
  assert.equal(aud.n, 1);
  await a.close();
});

test("再次提交取代待确认的提纲；没有提纲的任务出文书不受影响；引用别的事项的事实被拒", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "研究", stance: "原告", consent_status: "agreed" });
  const { matter: other } = await tk.inv("matters.create", { title: "别的事项", stance: "原告", consent_status: "agreed" });
  const a = await agentFor(matter.matter_id, "outline2");
  const plain = await a.call("docx.render_report", { title: "备忘录", sections: [{ heading: "结论", paragraphs: ["略"] }] });
  assert.match(plain.artifact_version_id, /^artv_/, "没有提纲：不受门禁影响");
  const first = await a.call("outline.submit", { doc_kind: "法律研究备忘录", arguments: [{ claim: "甲" }] });
  const second = await a.call("outline.submit", { doc_kind: "法律研究备忘录", arguments: [{ claim: "乙" }] });
  const rows = tk.kernel.db.all<{ outline_id: string; status: string }>(`SELECT outline_id, status FROM argument_outlines WHERE run_id = ? ORDER BY seq`, [a.live.rid]);
  assert.deepEqual(rows.map((r) => r.status), ["withdrawn", "proposed"]);
  assert.equal(rows[1]!.outline_id, second.outline_id);
  await assert.rejects(tk.inv("outlines.decide", { matter_id: matter.matter_id, outline_id: first.outline_id, decisions: [] }), /取代/);
  tk.kernel.db.run(`INSERT INTO matter_facts (fact_id, tenant_id, matter_id, seq, statement, kind, anchor_status, status) VALUES ('fct_other', ?, ?, 1, '别处的事实', 'claimed', 'no_document', 'proposed')`, [a.live.tid, other.matter_id]);
  const bad = await a.raw("outline.submit", { doc_kind: "起诉状", arguments: [{ claim: "丙", facts: [{ fact_id: "fct_other" }] }] });
  assert.equal(bad.result?.isError, true);
  assert.match(JSON.stringify(bad), /不在本事项/);
  await a.close();
});
