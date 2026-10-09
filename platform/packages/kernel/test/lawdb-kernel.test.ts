/**
 * 内核法规库集成（方案 §9、第 5 篇 §2.1）：lawdb.status（法规库最后更新日）、加载留痕、
 * 案号 →「未核实（离线）」→ 签发拦截（该引用不得进入签发版）；无法条引用时签发与导出照常。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, runScenario, importText, type TestKernel } from "./helpers.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({}, "lawdb-firm");
});

after(async () => {
  await tk.kernel.close();
});

const CONTRACT_WITH_CASE = [
  "股权转让协议（示例文本）",
  "第七条 保密",
  "7.1 乙方应当遵守《律师法》第三十八条规定的保密义务。",
  "7.2 类似争议参见（2023）最高法民终123号判决。",
].join("\n");

test("lawdb.status：版本/更新日/签名有效；加载留痕上链", async () => {
  const st = await tk.inv("lawdb.status");
  assert.match(st.package_version, /^g0\./);
  assert.equal(st.signature_valid, true);
  assert.equal(st.laws_count, 3);
  assert.equal(st.versions_count, 4);
  assert.match(st.display, /法规库最后更新/);
  const row = tk.kernel.db.get(`SELECT * FROM audit_events WHERE action = 'lawdb.load' AND object_id = ?`, [st.package_version]) as any;
  assert.ok(row, "lawdb.load 审计事件应落库");
  const onChain = tk.kernel.db.get(`SELECT 1 AS x FROM signed_events WHERE kind = 'audit_event' AND ref_id = ?`, [String(row.audit_event_id)]) as any;
  assert.ok(onChain, "lawdb.load 审计事件应入签名链");
});

test("案号 → 未核实（离线）→ 签发拦截；改引核验在 lawdb 上保持", { timeout: 240_000 }, async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "案号拦截测试事项", stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(inv, matter.matter_id, "协议.txt", CONTRACT_WITH_CASE);
  const d = await runScenario(inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id], topic_hint: "保密义务" }, 120_000);
  assert.equal(d.run.status, "succeeded");

  // 引用面板：38 条被拦截（改引 41），案号未核实（离线）
  const cit = d.events.find((e: any) => e.type === "citations.verified")!;
  assert.equal(cit.payload.unverified_offline, 1, JSON.stringify(cit.payload));
  const caseVerdict = cit.payload.verdicts.find((v: any) => v.kind === "case");
  assert.equal(caseVerdict.state, "unverified_offline");
  const statute38 = cit.payload.verdicts.find((v: any) => v.kind === "statute" && v.article === 38);
  assert.equal(statute38.state, "intercepted");
  assert.match(statute38.suggestion, /第四十一条/);
  assert.match(String(cit.payload.registry_coverage), /^g0\./, "registry_coverage 为 lawdb 包版本");

  const art = d.artifacts.find((a: any) => a.kind === "s1_opinion");

  // 完整性单 blockers 含「未核实（离线）」
  const comp = await inv("review.completeness", { artifact_version_id: art.artifact_version_id });
  assert.ok(comp.blockers.some((b: string) => /未核实（离线）/.test(b)), JSON.stringify(comp.blockers));

  // 签发被拦截（unverified_citations 409）
  await inv("review.submit", { artifact_version_id: art.artifact_version_id });
  await assert.rejects(
    () => inv("review.approve", { artifact_version_id: art.artifact_version_id, decision: "approved", expected_sha256: art.sha256 }),
    (e: any) => e.code === "unverified_citations" && /未核实（离线）/.test(e.message),
  );
});

test("无未核实引用时：签发与导出（export 动作校验）照常", { timeout: 240_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "导出校验测试事项", stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(inv, matter.matter_id, "协议.txt", "股权转让协议（示例）\n第七条 乙方应当遵守《民法典》第五百零九条规定的义务。");
  const d = await runScenario(inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] }, 120_000);
  const art = d.artifacts.find((a: any) => a.kind === "s1_opinion");
  const cit = d.events.find((e: any) => e.type === "citations.verified")!;
  assert.equal(cit.payload.unverified_offline, 0);
  await inv("review.submit", { artifact_version_id: art.artifact_version_id });
  const ok = await inv("review.approve", { artifact_version_id: art.artifact_version_id, decision: "approved", expected_sha256: art.sha256 });
  assert.equal(ok.status, "approved");
  // 导出（引用来源 official-gazette-selfbuilt 全动作允许 → export 校验通过）
  const dl = await inv("deliveries.create", { artifact_version_id: art.artifact_version_id, action: "download" });
  assert.equal(dl.package_sha256, art.sha256);
});
