/**
 * “将发送什么”与发送视图、疑似姓名核对（v9.2 §3.3–3.4；Y5 §3.3、§4.3 ②③；Y4 #15；P1-10、P1-11 ③）：
 * - 估价给出发送摘要：按类别的替换计数、机构名称是否保留、疑似未替换的姓名；预跑不写回令牌表；
 * - 发送视图只给令牌形态与位置，不含代号真值；
 * - L3a 事项有未核对的疑似姓名时估价与发起都被拦下；律师判定后（是姓名 → 加入当事人名单；不是 → 记住）即可发起，且之后发送稿里该名字已是代号；
 * - 删除事项时判定记录一并清除。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, importText } from "./helpers.ts";

process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "send-preview-test-secret-0123456789";

const FULL = { engagement: "confirmed", personal_info: "confirmed", sensitive: "confirmed", subprocessor: "confirmed" };
const TEXT = "甲方代表陈建国，电话 13911112222。陈建国与李华共同签署了补充协议。据告郑秀英称当晚并未离开。乙方：滨江置业有限公司。";

test("L2：估价附发送摘要（计数、公司名称保留、疑似姓名）；发送视图不含真值；预跑不写回令牌表；不拦发起", { timeout: 120_000 }, async () => {
  const tk = await makeKernel({}, "send-preview-l2");
  try {
    const { matter } = await tk.inv("matters.create", { title: "补充协议审查", stance: "原告", basis: FULL });
    await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "陈建国", kind: "person" });
    await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "滨江置业有限公司", kind: "org" });
    const doc = await importText(tk.inv, matter.matter_id, "补充协议.txt", TEXT);
    const before = tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matter_tokens WHERE matter_id = ?`, [matter.matter_id])!.n;
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s1.contract_review", document_version_ids: [doc.document_version_id] });
    const s = est.data_where.send_summary;
    assert.ok(s, "有发送摘要");
    assert.equal(s.docs, 1);
    assert.ok((s.replaced.person ?? 0) >= 2 && (s.replaced.phone ?? 0) >= 1, JSON.stringify(s.replaced));
    assert.equal(s.orgs_kept, true);
    assert.ok(s.suspects.unreviewed >= 2, JSON.stringify(s.suspects));
    assert.equal(est.data_where.start_blocked, false, "L2 不拦");
    const after = tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matter_tokens WHERE matter_id = ?`, [matter.matter_id])!.n;
    assert.equal(after, before, "预跑不写回令牌表");

    const pv = await tk.inv("materials.send_preview", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
    const json = JSON.stringify(pv);
    assert.ok(!json.includes("陈建国") && !json.includes("13911112222"), "发送视图不含代号真值");
    assert.ok(pv.sent_text.includes("滨江置业有限公司"), "L2 当事人名单中的公司名称也保留原文");
    for (const t of pv.tokens) assert.match(pv.sent_text.slice(t.start, t.end), /^〔[^〔〕]+·[0-9A-Z]{6,10}〕$/);
    const suspectTexts = pv.suspects.map((x: any) => pv.sent_text.slice(x.start, x.end));
    assert.ok(suspectTexts.includes("李华") && suspectTexts.includes("郑秀英"), JSON.stringify(suspectTexts));
    await assert.rejects(() => tk.inv("materials.send_preview", { matter_id: matter.matter_id, document_version_id: "nope" }), (e: any) => e.code === "not_found");
    // 悬停还原：发送视图里的代号可经受审计的还原接口逐个还原（发送视图写回了令牌表）
    const first = pv.tokens.find((t: any) => t.category === "自然人");
    const restored = await tk.inv("matters.tokens.restore", { matter_id: matter.matter_id, text: pv.sent_text.slice(first.start, first.end) });
    assert.equal(restored.text, "陈建国");
  } finally {
    await tk.kernel.close();
  }
});

test("L3a：有未核对的疑似姓名时估价与发起都被拦下；判定后放行，名字进入当事人名单并在发送稿中成为代号；删除事项清除判定", { timeout: 120_000 }, async () => {
  const tk = await makeKernel({ ZR_FIRM_L3A_STANDARD_MODEL: "allow" }, "send-preview-l3a");
  try {
    const { matter } = await tk.inv("matters.create", { title: "敏感借贷纠纷", stance: "原告", confidentiality: "high", basis: FULL });
    await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "陈建国", kind: "person" });
    await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "滨江置业有限公司", kind: "org" });
    const doc = await importText(tk.inv, matter.matter_id, "借条.txt", TEXT);
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s1.contract_review", document_version_ids: [doc.document_version_id] });
    assert.equal(est.data_where.start_blocked, true);
    assert.equal(est.data_where.block_kind, "suspects");
    assert.equal(est.data_where.send_summary.orgs_kept, false, "L3a 全部化名");
    await assert.rejects(
      () => tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `sp-${Date.now()}` }),
      (e: any) => e.code === "validation" && e.detail?.block_kind === "suspects",
    );
    const list = await tk.inv("matters.suspects.list", { matter_id: matter.matter_id, document_version_ids: [doc.document_version_id] });
    const values = list.suspects.map((x: any) => x.value).sort();
    assert.ok(values.includes("李华") && values.includes("郑秀英"), JSON.stringify(values));
    await assert.rejects(() => tk.inv("matters.suspects.review", { matter_id: matter.matter_id, items: [{ value: "李华", decision: "maybe" }] }), (e: any) => e.code === "validation");
    const items = list.suspects.map((x: any) => ({ value: x.value, decision: x.value === "郑秀英" ? "not_name" : "name" }));
    const rv = await tk.inv("matters.suspects.review", { matter_id: matter.matter_id, items });
    assert.equal(rv.rejected.length, 0, JSON.stringify(rv.rejected));
    assert.ok(tk.kernel.db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'matter.suspects_reviewed'`), "记审计");
    const parties = (await tk.inv("matters.parties.list", { matter_id: matter.matter_id })).parties.map((p: any) => p.name);
    assert.ok(parties.includes("李华") && !parties.includes("郑秀英"));
    const est2 = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s1.contract_review", document_version_ids: [doc.document_version_id] });
    assert.equal(est2.data_where.start_blocked, false, JSON.stringify(est2.data_where));
    const pv = await tk.inv("materials.send_preview", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
    assert.ok(!pv.sent_text.includes("李华"), "判为姓名的已换成代号");
    assert.ok(pv.sent_text.includes("郑秀英") && !pv.suspects.some((x: any) => pv.sent_text.slice(x.start, x.end) === "郑秀英"), "判为不是姓名的不再标出");
    assert.ok(!pv.sent_text.includes("滨江置业有限公司"), "L3a 当事人名单中的公司名称也换成代号");
    // 删除事项：判定记录一并清除
    await tk.inv("matters.close", { matter_id: matter.matter_id, retention_years: 1 });
    const purged = await tk.inv("matters.purge", { matter_id: matter.matter_id, confirm_title: "敏感借贷纠纷", early: true, reason: "客户书面要求删除" });
    assert.equal(purged.lifecycle.lifecycle, "purged");
    assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matter_suspect_reviews WHERE matter_id = ?`, [matter.matter_id])!.n, 0);
  } finally {
    await tk.kernel.close();
  }
});

test("复核 S5A-02：L3a 核对覆盖实际发送的全部内容——40 万字之后出现的疑似姓名同样拦下发起", { timeout: 180_000 }, async () => {
  const tk = await makeKernel({ ZR_FIRM_L3A_STANDARD_MODEL: "allow" }, "send-preview-long");
  try {
    const { matter } = await tk.inv("matters.create", { title: "长卷宗", stance: "原告", confidentiality: "high", basis: FULL });
    const filler = "第一条 本合同的签订、履行与解释适用中华人民共和国法律。\n".repeat(16_000);
    assert.ok(filler.length > 400_000);
    const doc = await importText(tk.inv, matter.matter_id, "长卷宗.txt", `${filler}据告郑秀英称当晚并未离开。`);
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id], goal: "整理" });
    assert.equal(est.data_where.block_kind, "suspects", JSON.stringify(est.data_where.send_summary));
    assert.equal(est.data_where.send_summary.truncated, false);
  } finally {
    await tk.kernel.close();
  }
});
