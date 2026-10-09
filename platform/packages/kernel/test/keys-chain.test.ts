/**
 * 签名事件 hash 链端到端（方案 v5.0 第 4 篇 §5.2/§6.4）：
 * S1 全链路 → 四类业务行（run_event/audit_event/egress_record/approval）均有签名见证；
 * 篡改业务行 → payload 不匹配报 first_bad_seq；篡改见证行签名 → 验签失败；手动检查点可验。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, runScenario, importText, DEMO_CONTRACT, type TestKernel } from "./helpers.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({}, "chain-firm");
});

after(async () => {
  await tk.kernel.close();
});

function chain() {
  return tk.inv("audit.verifyChain");
}

test("签名事件链：覆盖、篡改检测与检查点", { timeout: 240_000 }, async () => {
  const { inv, kernel } = tk;
  const db = kernel.db;

  // 1. 跑一个 S1 并签发（制造四类签名事件）
  const { matter } = await inv("matters.create", { title: "链上测试事项", stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(inv, matter.matter_id, "协议.txt", DEMO_CONTRACT);
  const d = await runScenario(inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id], topic_hint: "保密义务" }, 120_000);
  assert.equal(d.run.status, "succeeded");
  const art = d.artifacts.find((a: any) => a.kind === "s1_opinion");
  await inv("review.submit", { artifact_version_id: art.artifact_version_id });
  const ok = await inv("review.approve", { artifact_version_id: art.artifact_version_id, decision: "approved", expected_sha256: art.sha256, checklist: { reviewed_open_items: true } });
  assert.equal(ok.assurance_level, "device_signature");

  // 2. verifyChain ok；四类 kind 全覆盖
  const v0 = await chain();
  assert.equal(v0.ok, true, JSON.stringify(v0.failures));
  assert.ok(v0.checked > 10, `链上应有足够事件，实际 ${v0.checked}`);
  const kinds = new Set(db.all(`SELECT DISTINCT kind FROM signed_events`, []).map((r: any) => r.kind));
  for (const k of ["run_event", "audit_event", "egress_record", "approval"]) assert.ok(kinds.has(k), `signed_events 缺少 ${k}`);
  // 链头连续（prev 链接）与 lamport 递增
  const seqs = db.all(`SELECT seq, prev_hash, event_hash, lamport FROM signed_events ORDER BY seq`, []) as any[];
  for (let i = 1; i < seqs.length; i++) {
    assert.equal(seqs[i].prev_hash, seqs[i - 1].event_hash, `seq ${seqs[i].seq} prev 断链`);
    assert.ok(seqs[i].lamport > seqs[i - 1].lamport, "lamport 应递增");
  }

  // 3. 干净状态手动检查点
  const cp = await inv("audit.checkpoint", {});
  assert.ok(cp.checkpoint, "应写入检查点");
  // 链头未变 → 不重复检查点
  const cp2 = await inv("audit.checkpoint", {});
  assert.equal(cp2.checkpoint, null);
  const v1 = await chain();
  assert.equal(v1.ok, true);
  assert.ok(v1.checkpoints.length >= 1 && v1.checkpoints.every((c: any) => c.ok), "检查点应全部有效");

  // 4. 篡改业务行（run_events.payload）→ payload 不匹配 + first_bad_seq
  const target = db.get(`SELECT ref_id FROM signed_events WHERE kind = 'run_event' ORDER BY seq LIMIT 1`, []) as any;
  const orig = db.get(`SELECT payload FROM run_events WHERE event_id = ?`, [Number(target.ref_id)]) as any;
  db.run(`UPDATE run_events SET payload = ? WHERE event_id = ?`, [JSON.stringify({ tampered: true }), Number(target.ref_id)]);
  const v2 = await chain();
  assert.equal(v2.ok, false);
  assert.ok(v2.first_bad_seq !== null, "应报告 first_bad_seq");
  assert.ok(v2.failures.some((f: any) => /payload 不匹配/.test(f.reason)), JSON.stringify(v2.failures));
  // 还原后恢复 ok
  db.run(`UPDATE run_events SET payload = ? WHERE event_id = ?`, [orig.payload, Number(target.ref_id)]);
  const v3 = await chain();
  assert.equal(v3.ok, true, JSON.stringify(v3.failures));

  // 5. 篡改见证行签名 → 验签失败
  const sigRow = db.get(`SELECT seq, signature FROM signed_events ORDER BY seq DESC LIMIT 1`, []) as any;
  db.run(`UPDATE signed_events SET signature = ? WHERE seq = ?`, ["AAAA" + sigRow.signature.slice(4), sigRow.seq]);
  const v4 = await chain();
  assert.equal(v4.ok, false);
  assert.equal(v4.first_bad_seq, sigRow.seq);
  assert.ok(v4.failures.some((f: any) => /验签失败/.test(f.reason)), JSON.stringify(v4.failures));
  db.run(`UPDATE signed_events SET signature = ? WHERE seq = ?`, [sigRow.signature, sigRow.seq]);
  const v5 = await chain();
  assert.equal(v5.ok, true, JSON.stringify(v5.failures));

  // 6. 删除中间一行 → 断链
  const mid = db.get(`SELECT seq FROM signed_events ORDER BY seq LIMIT 1 OFFSET 3`, []) as any;
  const midRow = db.get(`SELECT * FROM signed_events WHERE seq = ?`, [mid.seq]) as any;
  db.run(`DELETE FROM signed_events WHERE seq = ?`, [mid.seq]);
  const v6 = await chain();
  assert.equal(v6.ok, false);
  assert.ok(v6.failures.some((f: any) => /断链/.test(f.reason)), JSON.stringify(v6.failures));
  db.run(
    `INSERT INTO signed_events (seq, kind, ref_id, matter_id, type, payload_hash, lamport, key_epoch, rev_checkpoint_hash, prev_hash, event_hash, signature, signer_device_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [midRow.seq, midRow.kind, midRow.ref_id, midRow.matter_id, midRow.type, midRow.payload_hash, midRow.lamport, midRow.key_epoch, midRow.rev_checkpoint_hash, midRow.prev_hash, midRow.event_hash, midRow.signature, midRow.signer_device_id, midRow.created_at],
  );
  const v7 = await chain();
  assert.equal(v7.ok, true, JSON.stringify(v7.failures));
});

test("egress_record 生命周期列 UPDATE 不破链；信封内列篡改检出", { timeout: 60_000 }, async () => {
  const { kernel } = tk;
  const db = kernel.db;
  // 前置：上一测试的 S1 已产生 egress_record 签名见证（mock 链路也落记录）
  const rec = db.get(`SELECT ref_id FROM signed_events WHERE kind = 'egress_record' ORDER BY seq LIMIT 1`, []) as any;
  assert.ok(rec, "前置条件：应存在 egress_record 签名见证");
  const row = db.get(`SELECT * FROM egress_records WHERE record_id = ?`, [rec.ref_id]) as any;

  // 模拟生命周期写入：broker request_id 回填（broker.ts）+ markFailed(outcome/note)——信封外，链不受影响
  db.run(`UPDATE egress_records SET request_id = ? WHERE record_id = ?`, ["req-backfill-simulated", rec.ref_id]);
  db.run(`UPDATE egress_records SET outcome = 'failed', note = COALESCE(note || '；', '') || ? WHERE record_id = ?`, ["发送失败：模拟上游 503", rec.ref_id]);
  const v1 = await chain();
  assert.equal(v1.ok, true, `生命周期列 UPDATE 不应破链：${JSON.stringify(v1.failures)}`);

  // 篡改信封内列（目的地主机）→ payload 不匹配检出
  db.run(`UPDATE egress_records SET destination_host = ? WHERE record_id = ?`, ["evil.example.com", rec.ref_id]);
  const v2 = await chain();
  assert.equal(v2.ok, false);
  assert.ok(v2.failures.some((f: any) => /payload 不匹配/.test(f.reason)), JSON.stringify(v2.failures));

  // 篡改字符数（信封内）→ 同样检出
  db.run(`UPDATE egress_records SET destination_host = ?, chars = chars + 1 WHERE record_id = ?`, [row.destination_host, rec.ref_id]);
  const v3 = await chain();
  assert.equal(v3.ok, false);

  // 全部还原（含生命周期列），链恢复 ok
  db.run(`UPDATE egress_records SET destination_host = ?, chars = ?, request_id = ?, outcome = ?, note = ? WHERE record_id = ?`, [
    row.destination_host,
    row.chars,
    row.request_id,
    row.outcome,
    row.note,
    rec.ref_id,
  ]);
  const v4 = await chain();
  assert.equal(v4.ok, true, JSON.stringify(v4.failures));
});
