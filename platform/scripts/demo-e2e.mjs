#!/usr/bin/env node
/**
 * G0 标准演示用例自动化演示路径（方案 v5.0 §16.2「标准演示用例」；docs/演示脚本-G0.md 的机跑版）。
 *
 * 一键跑通并打印各阶段证据：
 *   ① 示例事项（合成材料，标题标注示例） → ② 导入合同（引用《律师法》第三十八条） →
 *   ③ S1 审查（断网声明点：引用核验全程本机法规库，零网络） → 拦截 38 条 + 改引第四十一条 →
 *   ④ 时点对照（2026-08-31 修正施行前：旧版当时有效，核验通过） →
 *   ⑤ 数据去向卡摘要（mock 链路：只有「本机，未外发」记录） →
 *   ⑥ 设备签名签发 → approvals.verify 证明包 → 改一字节即 invalid → 还原即 valid →
 *   ⑦ 审计链 audit.verifyChain。
 *
 * 用法：npm run demo:e2e（自动先构建法规库与签名 profile）。
 * 退出码：任一证据断言失败即非零；全部通过打印 DEMO-E2E OK。
 * 说明：模型推理为离线 mock 提供方（演示链路语义，不冒充真实供应商）；本脚本不构成法律意见。
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "demo-e2e-secret-0123456789abcdef";

const DEMO_CONTRACT = [
  "股权转让协议（示例文本）",
  "第七条 保密",
  "7.1 乙方应当遵守《律师法》第三十八条规定的保密义务，不得泄露在履行本协议过程中知悉的甲方商业秘密。",
  "7.2 双方其他权利义务适用《民法典》第五百零九条。",
  "联系人：张律师，手机 13800138000（示例）。",
].join("\n");

let stage = "init";
const evidence = {};
function banner(s) {
  stage = s;
  console.log(`\n═══ ${s} ${"═".repeat(Math.max(2, 40 - s.length * 2))}`);
}
function check(cond, msg) {
  if (!cond) throw new Error(`证据断言失败[${stage}]：${msg}`);
  console.log(`  ✓ ${msg}`);
}

const { createKernel } = await import("../packages/kernel/src/index.ts");
const dir = mkdtempSync(join(tmpdir(), "kwl-demo-"));
const kernel = await createKernel({
  dataDir: dir,
  firmSlug: "demo-firm",
  userSlug: "demo-lawyer",
  // 改号拦截演示用测试夹具法规库（含虚构的《律师法》2026 修正本，不随包分发；v9.4 第 19 批 S-07）
  env: { ...process.env, ZR_MODEL_PROVIDER: "mock", ZR_LAWDB_FILE: process.env.ZR_LAWDB_FILE ?? fileURLToPath(new URL("../content/lawdb/test-fixtures/lawdb-renumber-demo.sqlite", import.meta.url)) },
});
const inv = (m, p) => kernel.invoke(m, p);
const waitRun = async (runId, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await inv("runs.get", { run_id: runId });
    if (["succeeded", "failed", "cancelled"].includes(d.run.status)) {
      const ev = await inv("runs.events", { run_id: runId, limit: 500 });
      return { run: d.run, artifacts: d.artifacts, events: ev.events };
    }
    if (Date.now() > deadline) throw new Error(`任务 ${runId} 超时`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

try {
  banner("① 内核启动与首日激活（离线演示形态）");
  const st = await inv("kernel.status");
  console.log(`  内核版本 ${st.version}；法规库包 ${st.lawdb_package ?? "（见 status）"}；模型提供方 ${st.model_provider}`);
  check(st.model_provider === "mock", "离线 mock 提供方：模型推理在本机模拟，无网络外发");
  check(st.local_server.rejected_path_requests === 0, "遥测/更新/远程控制零外连（非白名单路径请求 = 0）");

  banner("② 示例事项与合同导入（合成材料）");
  const { matter } = await inv("matters.create", {
    title: "甲公司受让乙公司股权（示例）",
    stance: "受让方",
    jurisdiction: "内地民商事",
    model_endpoint: "standard",
    collab_scope: "personal",
    consent_status: "not_required",
    key_dates: { analysis_as_of: "2026-10-01" },
  });
  console.log(`  事项 ${matter.matter_id}（标题含「示例」标注；合成合同文本）`);
  const doc = await inv("materials.import", {
    matter_id: matter.matter_id,
    filename: "股权转让协议-示例.txt",
    data_base64: Buffer.from(DEMO_CONTRACT, "utf8").toString("base64"),
    mime: "text/plain",
  });
  check(!!doc.parse_version_id, `合同已导入并解析（parse_version ${doc.parse_version_id}）`);

  banner("③ S1 合同审查：断网法条核验（本机法规库，零网络）");
  console.log("  【断网声明点】本阶段的引用核验只读随包法规库（本机 SQLite），不发起任何网络请求；");
  console.log("  证据：citations.verified 事件 where 字段 + ④ 时点对照 + egress 记录只有 mock_local。");
  const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s1.contract_review", document_version_ids: [doc.document_version_id], topic_hint: "保密义务" });
  const run = await inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `demo-${Date.now()}` });
  const d = await waitRun(run.run_id);
  check(d.run.status === "succeeded", "S1 任务完成（草稿成果，不直接对外）");
  const cit = d.events.find((e) => e.type === "citations.verified");
  check(!!cit, "citations.verified 事件存在");
  console.log("  核验拦截证据 JSON：");
  console.log(JSON.stringify({ intercepted: cit.payload.intercepted, where: cit.payload.where, items: cit.payload.intercepted_items }, null, 2).split("\n").map((l) => `    ${l}`).join("\n"));
  check(cit.payload.intercepted === 1, "拦截 1 条：《律师法》第三十八条（2026-09-01 修正施行后已调整）");
  check(/第四十一条/.test(cit.payload.intercepted_items[0].suggestion), "改引建议指向第四十一条");
  check(cit.payload.where === "本机（离线核验）", "核验位置 = 本机（离线核验）");
  evidence.citations = cit.payload;

  banner("④ 时点对照：2026-08-31（修正施行前）旧版引用核验通过");
  const { matter: m2 } = await inv("matters.create", {
    title: "时点对照事项（示例）",
    stance: "受让方",
    consent_status: "not_required",
    key_dates: { analysis_as_of: "2026-08-31" },
  });
  const doc2 = await inv("materials.import", { matter_id: m2.matter_id, filename: "协议-时点对照-示例.txt", data_base64: Buffer.from(DEMO_CONTRACT, "utf8").toString("base64"), mime: "text/plain" });
  const est2 = await inv("runs.estimate", { matter_id: m2.matter_id, scenario: "s1.contract_review", document_version_ids: [doc2.document_version_id], topic_hint: "保密义务" });
  const run2 = await inv("runs.start", { matter_id: m2.matter_id, estimate_id: est2.estimate_id, idempotency_key: `demo-asof-${Date.now()}` });
  const d2 = await waitRun(run2.run_id);
  const cit2 = d2.events.find((e) => e.type === "citations.verified");
  check(d2.run.status === "succeeded" && cit2?.payload.intercepted === 0, "2026-08-31 时点：第三十八条当时有效，核验通过（拦截 0 条）");
  evidence.asOfContrast = { as_of: "2026-08-31", intercepted: cit2.payload.intercepted };

  banner("⑤ 数据去向卡（只有本机 mock 记录，无任何网络外发）");
  const eg = await inv("egress.records", { run_id: run.run_id });
  console.log("  去向记录摘要：");
  for (const r of eg.records) console.log(`    - ${r.destination_kind} / ${r.destination_host} / ${r.chars} 字符 / outcome=${r.outcome} / ${r.note}`);
  check(eg.records.length === 1 && eg.records[0].destination_kind === "mock_local", "mock 链路唯一去向记录 = mock_local（本机，未外发）");
  evidence.egress = eg.records.map((r) => ({ destination_kind: r.destination_kind, destination_host: r.destination_host, outcome: r.outcome }));

  banner("⑥ 设备签名签发与离线验证（改一字节即失效）");
  const art = d.artifacts.find((a) => a.kind === "s1_opinion");
  check(!!art && art.status === "draft", "成果为 internal 草稿（签发前不可对外）");
  await inv("review.submit", { artifact_version_id: art.artifact_version_id });
  const ok = await inv("review.approve", {
    artifact_version_id: art.artifact_version_id,
    decision: "approved",
    expected_sha256: art.sha256,
    checklist: { reviewed_open_items: true, audience_confirmed: true },
  });
  check(ok.assurance_level === "device_signature", "签发保证等级 = device_signature（设备签名）");
  const v1 = await inv("approvals.verify", { approval_id: ok.approval_id });
  check(v1.overall === "valid" && v1.artifact_hash_match && v1.signature_valid && v1.cert_chain_valid, "approvals.verify：overall=valid（hash/签名/证书链一致）");
  console.log("  签发证明包（离线可验，不查库）：");
  console.log(`    signed_payload: ${v1.proof.signed_payload.slice(0, 120)}…`);
  console.log(`    signature: ${String(v1.proof.signature).slice(0, 48)}…`);
  console.log(`    cert_json / root_public_key_pem 已随包（字段齐备）`);
  evidence.signProof = { approval_id: ok.approval_id, overall: v1.overall, assurance_level: ok.assurance_level };
  // 篡改一个字节 → invalid；还原 → valid
  const artRow = kernel.db.get(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [art.artifact_version_id]);
  const blobPath = kernel.blobs.pathOf(String(artRow.storage_uri));
  const origBytes = readFileSync(blobPath);
  const tampered = Buffer.from(origBytes);
  tampered[0] = tampered[0] ^ 0xff;
  writeFileSync(blobPath, tampered);
  const v2 = await inv("approvals.verify", { approval_id: ok.approval_id });
  check(v2.overall === "invalid" && v2.artifact_hash_match === false, "篡改一个字节后：overall=invalid（hash 不符）");
  writeFileSync(blobPath, origBytes);
  const v3 = await inv("approvals.verify", { approval_id: ok.approval_id });
  check(v3.overall === "valid", "还原后：overall=valid（离线可重复验证）");
  evidence.tamper = { tampered_overall: v2.overall, restored_overall: v3.overall };

  banner("⑦ 审计链完整性（audit.verifyChain）");
  const chain = await inv("audit.verifyChain", {});
  console.log(`  ${JSON.stringify(chain)}`);
  check(chain.ok === true || chain.valid === true, `签名事件链完整：${JSON.stringify(chain)}`);
  evidence.auditChain = chain;

  console.log("\n═══ DEMO-E2E OK：标准演示用例全链证据就绪 ═══");
  console.log(`证据对象键：${Object.keys(evidence).join(", ")}`);
  await kernel.close();
  process.exit(0);
} catch (e) {
  console.error(`\n✗ DEMO-E2E 失败[${stage}]：${e.message}`);
  try {
    await kernel.close();
  } catch {
    // 忽略关闭异常
  }
  process.exit(1);
}
