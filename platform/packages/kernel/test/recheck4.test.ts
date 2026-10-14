/**
 * 阶段 4 复核新问题（内核侧）的回归：
 * - S4-20 学得的别名标“待确认”（照常参与匹配）；律师可确认、驳回（此后不再学回）、停用自动派生的字号；常用词不能作别名；
 * - S4-21 两阶段去向记录：预写标未完成并把出站内容摘要计入签名信封；补全追加签名审计事件；
 *   未补全的预写在闸门重拉（或内核启动）时标为“结果不明”并进入人工对账；签名链整体仍可校验。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { GateEgressRecord } from "@zr-legal/egress-gate";
import { makeKernel, importText, type TestKernel } from "./helpers.ts";
import { MatterTokenStore } from "../src/egress/matter-tokens.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({}, "recheck4-firm");
});

after(async () => {
  await tk.kernel.close();
});

test("S4-20 学得的别名：标待确认、照常匹配；确认后转正；驳回后不再学回；常用词不能作别名；派生字号可停用", { timeout: 60_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "别名", stance: "原告", client_name: "孙悦", counterparty: "北京明天科技有限公司", consent_status: "agreed" });
  const mid = matter.matter_id as string;
  const store = new MatterTokenStore(tk.kernel.db);
  const text = "原告孙悦（以下简称“悦姐”）诉被告北京明天科技有限公司（以下简称“明天科技”）。保证人孙悦（以下简称“本人”）。";
  await importText(inv, mid, "起诉状.txt", text);
  assert.equal(store.learnAliases(mid, [text], "u"), 2);
  let parties = (await inv("matters.parties.list", { matter_id: mid })).parties as any[];
  const sun = parties.find((p) => p.name === "孙悦");
  const org = parties.find((p) => p.name === "北京明天科技有限公司");
  assert.deepEqual(sun.learned, ["悦姐"]);
  assert.deepEqual(sun.aliases, []);
  assert.deepEqual(org.learned, ["明天科技"]);
  assert.ok(org.derived.includes("北京明天科技") && !org.derived.includes("明天"), JSON.stringify(org.derived));
  // 待确认的别名照常参与匹配
  assert.ok(!store.tokenizer(mid).tokenize("悦姐已签字").text.includes("悦姐"));
  // 确认
  await inv("matters.parties.alias", { matter_id: mid, name: "孙悦", alias: "悦姐", action: "confirm" });
  parties = (await inv("matters.parties.list", { matter_id: mid })).parties;
  assert.deepEqual(parties.find((p: any) => p.name === "孙悦").aliases, ["悦姐"]);
  assert.deepEqual(parties.find((p: any) => p.name === "孙悦").learned, []);
  // 驳回学得的“明天科技”：不再匹配，再次学习也不写回
  await inv("matters.parties.alias", { matter_id: mid, name: "北京明天科技有限公司", alias: "明天科技", action: "reject" });
  assert.equal(store.learnAliases(mid, [text], "u"), 0);
  assert.ok(store.partiesIn(mid, "明天科技 合同纠纷").length === 0);
  // 停用派生字号“北京明天科技”，再撤销停用
  await inv("matters.parties.alias", { matter_id: mid, name: "北京明天科技有限公司", alias: "北京明天科技", action: "reject" });
  assert.deepEqual(store.partiesIn(mid, "北京明天科技 合同纠纷"), []);
  await inv("matters.parties.alias", { matter_id: mid, name: "北京明天科技有限公司", alias: "北京明天科技", action: "restore" });
  assert.deepEqual(store.partiesIn(mid, "北京明天科技 合同纠纷"), ["北京明天科技"]);
  // 常用词不能作别名
  await assert.rejects(inv("matters.parties.upsert", { matter_id: mid, name: "孙悦", kind: "person", aliases: ["本人"] }), /常用词或泛称/);
});

function rec(o: Partial<GateEgressRecord> & { requestId: string; matterId: string; tenantId: string }, opts: { noQuery?: boolean } = {}): GateEgressRecord {
  const r = {
    at: new Date().toISOString(),
    runId: "run_recheck4",
    purpose: "search",
    destination: "search_service",
    destinationHost: "search.example",
    outcome: "sent",
    reason: null,
    chars: 8,
    segments: 1,
    tokenized: {},
    media: [],
    query: { original: "股东出资 判例", sent: "股东出资 判例", decision: "pass" },
    policyVersion: 1,
    upstreamStatus: null,
    durationMs: 0,
    ...o,
  } as GateEgressRecord;
  if (opts.noQuery) delete r.query;
  return r;
}

test("S4-21 两阶段记录：预写未完成且内容摘要入签名信封；补全追加签名事件；未补全的在闸门重拉时标为结果不明并可对账；签名链校验通过", { timeout: 60_000 }, async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "两阶段", stance: "原告", consent_status: "agreed" });
  const mid = matter.matter_id as string;
  const tid = kernel.identity.tenantId;
  const onRecord = (r: GateEgressRecord) => (kernel.gate as unknown as { onRecord(r: GateEgressRecord): void }).onRecord(r);
  const row = (rid: string) => kernel.db.get<{ outcome: string; completed: number; content_digest: string | null; note: string }>(`SELECT outcome, completed, content_digest, note FROM egress_records WHERE request_id = ?`, [rid])!;

  // 1) 预写 + 补全
  onRecord(rec({ phase: "start", requestId: "req_a", matterId: mid, tenantId: tid }));
  let a = row("req_a");
  assert.equal(a.completed, 0);
  assert.equal(JSON.parse(a.note).phase, "start");
  assert.match(a.content_digest ?? "", /.{20,}/);
  onRecord(rec({ phase: "end", requestId: "req_a", matterId: mid, tenantId: tid, upstreamStatus: 200, durationMs: 12 }));
  a = row("req_a");
  assert.equal(a.completed, 1);
  assert.equal(a.outcome, "sent");
  assert.equal(JSON.parse(a.note).phase, "end");
  const completed = kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'egress.completed'`)!.n;
  assert.ok(completed >= 1);

  // 2) 中断的流式模型请求：本机无用量，备注写明以网关结算为准
  onRecord(rec({ phase: "start", requestId: "req_m", matterId: mid, tenantId: tid, purpose: "model", destination: "legal_gateway", model: "legal/k3" }, { noQuery: true }));
  onRecord(rec({ phase: "end", requestId: "req_m", matterId: mid, tenantId: tid, purpose: "model", destination: "legal_gateway", model: "legal/k3", outcome: "failed", reason: "aborted" }, { noQuery: true }));
  assert.match(JSON.parse(row("req_m").note).usage_note, /以网关结算为准/);

  // 3) 只有预写、闸门中断：闸门重拉前的清扫标为结果不明
  onRecord(rec({ phase: "start", requestId: "req_b", matterId: mid, tenantId: tid }));
  assert.equal(row("req_b").completed, 0);
  assert.equal(kernel.gate.sweepUnresolved(), 1);
  const b = row("req_b");
  assert.equal(b.outcome, "unknown");
  assert.equal(JSON.parse(b.note).reconcile, "pending");
  assert.equal(kernel.gate.sweepUnresolved(), 0, "清扫幂等");
  const unresolved = await inv("egress.unresolved", { matter_id: mid });
  assert.equal(unresolved.records.length, 1);
  assert.equal(unresolved.records[0].purpose, "search");
  // 4) 人工对账：登记结论（只追加结论与签名审计事件）
  const recordId = unresolved.records[0].record_id;
  await inv("egress.reconcile", { record_id: recordId, resolution: "not_sent" });
  assert.equal((await inv("egress.unresolved", { matter_id: mid })).records[0].reconcile, "done");
  await assert.rejects(inv("egress.reconcile", { record_id: (await inv("egress.records", { matter_id: mid })).records.find((r: any) => r.outcome === "sent").record_id, resolution: "not_sent" }), /结果不明/);

  // 5) 签名链：信封含内容摘要，补全与清扫都是追加的签名事件——整体校验通过
  const v = kernel.signer.verifyChain();
  assert.equal(v.ok, true, JSON.stringify(v));
  // 篡改信封内的事实（内容摘要）即校验失败
  kernel.db.run(`UPDATE egress_records SET content_digest = 'tampered' WHERE request_id = 'req_a'`);
  assert.equal(kernel.signer.verifyChain().ok, false);
});

test("终核 S4-21 残余：备注里的检索原文或 URL 被改即签名链校验失败；补全不改写内容字段；对账已有结论时须显式改判并保留历史", { timeout: 60_000 }, async () => {
  const { makeKernel } = await import("./helpers.ts");
  const k2 = await makeKernel({}, "recheck4b-firm");
  try {
    const { inv, kernel } = k2;
    const { matter } = await inv("matters.create", { title: "内容摘要", stance: "原告", consent_status: "agreed" });
    const mid = matter.matter_id as string;
    const tid = kernel.identity.tenantId;
    const onRecord = (r: GateEgressRecord) => (kernel.gate as unknown as { onRecord(r: GateEgressRecord): void }).onRecord(r);
    onRecord(rec({ phase: "start", requestId: "req_c", matterId: mid, tenantId: tid }));
    // 补全时闸门送来的备注即使带了不同的查询，内容字段也保持预写时的值
    onRecord(rec({ phase: "end", requestId: "req_c", matterId: mid, tenantId: tid, query: { original: "被改过的查询", sent: "被改过的查询", decision: "pass" }, upstreamStatus: 200 }));
    const note = JSON.parse(kernel.db.get<{ note: string }>(`SELECT note FROM egress_records WHERE request_id = 'req_c'`)!.note);
    assert.equal(note.query.original, "股东出资 判例");
    assert.equal(kernel.signer.verifyChain().ok, true);
    // 只改备注里的检索原文（不动内容摘要列）：校验失败
    kernel.db.run(`UPDATE egress_records SET note = json_set(note, '$.query.original', '篡改') WHERE request_id = 'req_c'`);
    assert.equal(kernel.signer.verifyChain().ok, false);
    kernel.db.run(`UPDATE egress_records SET note = json_set(note, '$.query.original', '股东出资 判例') WHERE request_id = 'req_c'`);
    assert.equal(kernel.signer.verifyChain().ok, true, "改回即恢复");

    // 对账：已有结论时不能静默覆盖
    onRecord(rec({ phase: "start", requestId: "req_d", matterId: mid, tenantId: tid }));
    kernel.gate.sweepUnresolved();
    const id = (await inv("egress.unresolved", { matter_id: mid })).records[0].record_id;
    await inv("egress.reconcile", { record_id: id, resolution: "unknown" });
    await assert.rejects(inv("egress.reconcile", { record_id: id, resolution: "not_sent" }), /override/);
    await inv("egress.reconcile", { record_id: id, resolution: "not_sent", override: true });
    const n2 = JSON.parse(kernel.db.get<{ note: string }>(`SELECT note FROM egress_records WHERE record_id = ?`, [id])!.note);
    assert.equal(n2.resolution, "not_sent");
    assert.equal(n2.reconcile_history[0].resolution, "unknown");
    assert.equal(kernel.signer.verifyChain().ok, true, "对账只改生命周期字段，签名链仍完整");
  } finally {
    await k2.kernel.close();
  }
});
