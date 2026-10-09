/** S2 案卷整理端到端（内核版）：多材料入库 → 事实抽取（锚点入库可核验）→ 六件交付 → 质量报告如实降级。 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeKernel, runScenario, importText, downloadArtifact, type TestKernel } from "./helpers.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({}, "s2-firm");
});

after(async () => {
  await tk.kernel.close();
});

test("S2: 案卷整理六件交付 + 锚点入库 + 不擅自认定证明力", { timeout: 120_000 }, async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", {
    title: "买卖合同纠纷案卷",
    stance: "原告（买方）",
    client_name: "甲公司",
    counterparty: "乙公司",
    consent_status: "not_required",
    key_dates: { analysis_as_of: "2026-10-01" },
  });
  const d1 = await importText(inv, matter.matter_id, "买卖合同.txt", "买卖合同\n甲方：甲公司\n乙方：乙公司\n2024年3月15日签订本合同，合同金额 人民币 500,000 元。");
  const d2 = await importText(inv, matter.matter_id, "付款凭证.txt", "付款凭证\n2024-04-02 甲公司向乙公司支付预付款 150000元。\n2024年4月2日 银行回单确认。");
  const d3 = await importText(inv, matter.matter_id, "催告函.txt", "催告函\n2024年6月30日 甲公司函告乙公司要求交付货物。");

  const { run, artifacts, events } = await runScenario(inv, matter.matter_id, "s2.case_file", {
    document_version_ids: [d1.document_version_id, d2.document_version_id, d3.document_version_id],
    issues: ["乙公司是否构成迟延交付"],
  }, 90_000);
  assert.equal(run.status, "succeeded", JSON.stringify(events.map((e: any) => e.type)));

  // 六件交付
  const kinds = artifacts.map((a: any) => a.kind).sort();
  assert.deepEqual(kinds, ["s2_catalog", "s2_evidence_catalog", "s2_matrix", "s2_quality_report", "s2_supplement", "s2_timeline"]);

  // 事实抽取事件
  const fx = events.find((e: any) => e.type === "facts.extracted");
  assert.ok(fx.payload.dates >= 4, `dates=${fx.payload.dates}`);
  assert.ok(fx.payload.amounts >= 2, `amounts=${fx.payload.amounts}`);
  assert.ok(fx.payload.parties >= 2, `parties=${fx.payload.parties}`);

  // 锚点入库（定位正确率的核验基础）
  const anchors = kernel.db.all(
    `SELECT ea.* FROM evidence_anchors ea
     JOIN parse_versions pv ON pv.parse_version_id = ea.parse_version_id
     JOIN document_versions dv ON dv.document_version_id = pv.document_version_id
     WHERE dv.matter_id = ?`,
    [matter.matter_id],
  );
  assert.ok(anchors.length >= 8, `anchors=${anchors.length}`);

  // 锚点可定位验证：回切原文与登记 hash 一致
  const row = kernel.db.get<any>(
    `SELECT pt.content, ea.char_start, ea.char_end, ea.text_hash
       FROM evidence_anchors ea
       JOIN parse_versions pv ON pv.parse_version_id = ea.parse_version_id
       JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id
      WHERE pv.document_version_id = ?
      ORDER BY ea.char_start LIMIT 1`,
    [d2.document_version_id],
  );
  const sliced = (row.content as string).slice(row.char_start, row.char_end);
  assert.equal(createHash("sha256").update(sliced).digest("hex"), row.text_hash, "锚点区间回切原文须与登记 hash 一致");

  // 时间轴可下载
  const timeline = artifacts.find((a: any) => a.kind === "s2_timeline");
  const buf = await downloadArtifact(inv, timeline.artifact_version_id);
  assert.ok(buf.length > 0);
});
