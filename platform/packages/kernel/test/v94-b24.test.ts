/**
 * v9.4 第 24 批（10-23 用户拍板的待决项）：
 * - 对外版修订稿的作者名：设置里的修订署名；没填用本所名称；内部版仍用缺省写法；
 * - “论点未经确认”的成果：签发必过项，须写一句理由（进签发记录与签名载荷），或回去确认论点后重新生成；
 * - 不调用 AI 的本机流程（回稿比对、整理案卷、对外脱敏件）不计点：预计、预留、实扣都是 0；
 * - 被停用电脑的个人数据提示（members.personal_status）：开发形态没有吊销，只核结构；吊销后的提示见 cp-self-revoke；
 * - 本所范本库（C1 #23）：拆条、查客户信息（当事人含简称、案号、证件号、手机号、账号、邮箱）、换占位符、列表与删除、审合同卡片的条款比对。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDocx } from "@zr-legal/docx-engine";
import { importBytes, importText, liveTaskIdentity, makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { redlineAuthorOf } from "../src/services/doc-style.ts";
import { hasOutlineUnconfirmed, outlineUnconfirmedReason } from "../src/services/argument-outlines.ts";
import { estimatePoints, scenarioCap } from "../src/services/estimate.ts";
import { findHits, matchClauses, replaceHits, splitClauses } from "../src/services/firm-templates.ts";
import { submitRiskCards } from "../src/services/review-cards.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b24-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("对外版修订作者名：有署名用署名；没署名时对外版用本所名称、内部版用缺省；没激活记录时都用缺省", async () => {
  const { kernel, inv } = tk;
  const tid = kernel.identity.tenantId;
  assert.equal(redlineAuthorOf(kernel.db, tid, "external", "某某律师事务所"), "某某律师事务所");
  assert.equal(redlineAuthorOf(kernel.db, tid, "internal", "某某律师事务所"), null, "内部版不换");
  assert.equal(redlineAuthorOf(kernel.db, tid, "external", null), null, "没有激活记录（开发形态）用缺省");
  assert.equal((await inv("doc_style.get")).firm_name, null);
  await inv("doc_style.set", { redline_author: "王律师" });
  assert.equal(redlineAuthorOf(kernel.db, tid, "external", "某某律师事务所"), "王律师");
  assert.equal(redlineAuthorOf(kernel.db, tid, "internal", "某某律师事务所"), "王律师");
  await inv("doc_style.set", { redline_author: "" });
});

test("论点未经确认：复核页列为必过项；不写理由（或不足 4 字）不能签发；理由清洗后进签发记录与签名载荷；没有这一未决项的理由不记", async () => {
  const { kernel, inv } = tk;
  const ident = kernel.identity;
  assert.equal(hasOutlineUnconfirmed([{ kind: "outline_unconfirmed" }]), true);
  assert.equal(hasOutlineUnconfirmed([{ kind: "citation_intercepted" }]), false);
  assert.equal(outlineUnconfirmedReason("  已 \n 电话核过 "), "已 电话核过");
  assert.equal(outlineUnconfirmedReason("太短"), null);
  assert.equal([...outlineUnconfirmedReason("字".repeat(300))!].length, 200);

  const { matter } = await inv("matters.create", { title: "论点理由", stance: "原告", consent_status: "agreed" });
  const reg = (openItems: unknown[]) => {
    const bytes = Buffer.from(`民事起诉状（草稿）\n诉讼请求：判令被告支付货款。${randomUUID()}`, "utf8");
    const { sha256, storage_uri } = kernel.blobs.put(bytes, matter.matter_id);
    const id = `artv_${randomUUID()}`;
    kernel.db.run(
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, audience, version, filename, sha256, storage_uri, status, open_items, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'pending_review', ?, ?)`,
      [id, ident.tenantId, matter.matter_id, null, `b24_${randomUUID().slice(0, 8)}`, "internal", 1, "起诉状.md", sha256, storage_uri, JSON.stringify(openItems), ident.userId],
    );
    return { id, sha256 };
  };
  const a = reg([{ kind: "outline_unconfirmed", note: "这份成果产出时，论点与依据还没经你确认" }]);
  const c = await inv("review.completeness", { artifact_version_id: a.id });
  assert.equal(c.outline_unconfirmed, true);
  assert.ok(c.blockers.some((b: string) => /论点与依据没经你确认.*理由/.test(b)), JSON.stringify(c.blockers));
  const approve = (reason?: string) => inv("review.approve", { artifact_version_id: a.id, decision: "approved", expected_sha256: a.sha256, checklist: { reviewed_open_items: true, ...(reason === undefined ? {} : { outline_unconfirmed_reason: reason }) } });
  await assert.rejects(approve(), (e: any) => e.code === "outline_unconfirmed" && /写一句不确认就签发的理由/.test(e.message));
  await assert.rejects(approve(" 好的 "), (e: any) => e.code === "outline_unconfirmed");
  const ok = await approve("论点已在电话里\n与合伙人逐条核过");
  assert.equal(ok.status, "approved");
  const row = kernel.db.get<{ checklist: string; signed_payload: string }>(`SELECT checklist, signed_payload FROM approvals WHERE approval_id = ?`, [ok.approval_id])!;
  assert.equal(JSON.parse(row.checklist).outline_unconfirmed_reason, "论点已在电话里 与合伙人逐条核过");
  assert.equal(JSON.parse(row.signed_payload).outline_unconfirmed_reason, "论点已在电话里 与合伙人逐条核过");
  assert.equal((await inv("approvals.verify", { approval_id: ok.approval_id })).overall, "valid");

  // 没有这一未决项：界面带来的理由不记，签名载荷里为 null
  const b = reg([]);
  assert.equal((await inv("review.completeness", { artifact_version_id: b.id })).outline_unconfirmed, false);
  const ok2 = await inv("review.approve", { artifact_version_id: b.id, decision: "approved", expected_sha256: b.sha256, checklist: { reviewed_open_items: true, outline_unconfirmed_reason: "不该记下" } });
  const row2 = kernel.db.get<{ checklist: string; signed_payload: string }>(`SELECT checklist, signed_payload FROM approvals WHERE approval_id = ?`, [ok2.approval_id])!;
  assert.equal(JSON.parse(row2.checklist).outline_unconfirmed_reason, undefined);
  assert.equal(JSON.parse(row2.signed_payload).outline_unconfirmed_reason, null);
});

test("本机流程不计点：回稿比对、整理案卷、对外脱敏件预计 0 点、显示“不计点”；跑完预留与实扣都是 0；AI 流程照旧计点", { timeout: 120_000 }, async () => {
  const { inv } = tk;
  for (const s of ["s1b.draft_compare", "s2.case_file", "s6.redaction"]) {
    const e = estimatePoints({ scenario: s, material_count: 5, total_pages: 100 });
    assert.equal(e.points, 0, s);
    assert.equal(e.local, true);
    assert.equal(scenarioCap(s), 0);
  }
  assert.ok(estimatePoints({ scenario: "s1.contract_review", material_count: 1, total_pages: 2 }).points >= 30);
  assert.equal(estimatePoints({ scenario: "nope", material_count: 0, total_pages: 0 }).points, 0);
  assert.equal(estimatePoints({ scenario: "nope", material_count: 0, total_pages: 0 }).local, undefined, "未上架的场景仍不可估价");

  const { matter } = await inv("matters.create", { title: "不计点", stance: "原告", jurisdiction: "中国大陆", consent_status: "agreed" });
  const doc = await importText(inv, matter.matter_id, "对账函.txt", "2025年3月1日，被告确认欠付货款人民币12万元。\n2025年5月1日，原告发函催告。");
  const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s2.case_file", document_version_ids: [doc.document_version_id] });
  assert.equal(est.points, 0);
  assert.equal(est.points_display, "不调用 AI，不计点");
  assert.deepEqual(est.assumptions, []);
  // 界面带来的 budget_points 不起作用
  const run = await inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b24-local-${Date.now()}`, budget_points: 50 });
  assert.equal(run.points_reserved, 0);
  const d = await waitRun(inv, run.run_id, 90_000);
  assert.equal(d.run.status, "succeeded", JSON.stringify(d.run));
  assert.equal(d.run.points_reserved, 0);
  assert.equal(d.run.points_charged ?? 0, 0);
  const aiEst = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s1.contract_review", document_version_ids: [doc.document_version_id] });
  assert.match(aiEst.points_display, /^预计 \d+ 点$/);
});

test("被停用电脑的个人数据提示：没被停用时不提示", async () => {
  const { inv } = tk;
  await inv("writing_prefs.set", { signature: "某某律师事务所 李律师" });
  const s = await inv("members.personal_status");
  assert.deepEqual(s, { device_revoked: false, writing_prefs: true, qa_conversations: 0, prompt_clear: false });
  await inv("writing_prefs.set", { signature: "" });
});

const TEMPLATE_TEXT = [
  "采购合同（买方版）",
  "甲方：【买方】",
  "第一条 标的与数量",
  "1.1 卖方按附件一交付货物。",
  "第五条 付款",
  "买方应于货物验收合格并收到合规发票后六十日内支付货款。",
  "第八条 违约责任",
  "卖方逾期交货的，每逾期一日按未交货部分价款的千分之一支付违约金。",
  "第十二条 保密",
  "双方对因履行本合同知悉的对方商业秘密负保密义务，期限至该信息公开之日止。",
].join("\n");

test("范本拆条：首部单列；“第 X 条”起一条、下一级（1.1）不另起；没有条款标题时按段落", () => {
  const cs = splitClauses(TEMPLATE_TEXT);
  assert.deepEqual(cs.map((c) => [c.seq, c.heading]), [[0, "首部"], [1, "第一条 标的与数量"], [2, "第五条 付款"], [3, "第八条 违约责任"], [4, "第十二条 保密"]]);
  assert.match(cs[1]!.text, /1\.1 卖方按附件一交付货物/);
  const flat = splitClauses("甲方应按时付款。\n乙方应按时交货。");
  assert.deepEqual(flat.map((c) => c.seq), [1, 2]);
  assert.deepEqual(splitClauses("一、总则\n本合同适用于…\n二、付款\n按月结算。").map((c) => c.heading), ["一、总则", "二、付款"]);
});

test("查客户信息与换占位符：案号、证件号、手机号、账号、邮箱、当事人（由调用方给出位置）；长的先换", () => {
  const cs = splitClauses(["第一条 联系", "联系人 13800138000，邮箱 a.b@example.com，账号 6222020200112233445。", "第二条 争议", "参照（2024）沪0101民初123号判决；身份证号 110101199001011234。", "第三条 主体", "丙科技有限公司与丙科技均为本合同当事人。"].join("\n"));
  const spans = (t: string) => {
    const out: { start: number; end: number }[] = [];
    for (const name of ["丙科技有限公司", "丙科技"]) {
      let i = t.indexOf(name);
      while (i >= 0) {
        if (!out.some((s) => i >= s.start && i < s.end)) out.push({ start: i, end: i + name.length });
        i = t.indexOf(name, i + name.length);
      }
    }
    return out;
  };
  const hits = findHits(cs, spans);
  const kinds = hits.map((h) => `${h.seq}:${h.kind}:${h.text}`);
  for (const want of ["1:phone:13800138000", "1:email:a.b@example.com", "1:account:6222020200112233445", "2:case_no:（2024）沪0101民初123号", "2:id_no:110101199001011234", "3:party:丙科技有限公司", "3:party:丙科技"]) assert.ok(kinds.includes(want), `${want} 不在 ${kinds.join(" | ")}`);
  assert.ok(!kinds.includes("2:account:110101199001011234"), "身份证号不重复报成账号");
  const fixed = replaceHits(cs, hits);
  assert.equal(fixed[2]!.text, "第三条 主体\n【当事人】与【当事人】均为本合同当事人。");
  assert.match(fixed[1]!.text, /参照【案号】判决；身份证号 【证件号】/);
  assert.equal(findHits(fixed, spans).length, 0, "换完再查为空");
});

test("本所范本库：放入时查出事项当事人（含简称）与客户信息、不保存；换占位符后保存；名称里有当事人拒绝；列表、查看、删除；审计不记正文", async () => {
  const { inv, kernel } = tk;
  await inv("matters.create", { title: "范本当事人", stance: "买方", client_name: "丙科技有限公司", counterparty: "丁贸易有限公司", consent_status: "agreed" });
  const base = { title: "采购合同（买方版）", contract_type: "买卖", stance: "买方", note: "合伙人会议定稿" };
  await assert.rejects(inv("firm_templates.add", { ...base, contract_type: "不存在", text: TEMPLATE_TEXT }), /请选择合同类型/);
  await assert.rejects(inv("firm_templates.add", { ...base, title: "", text: TEMPLATE_TEXT }), /请填写范本名称/);
  await assert.rejects(inv("firm_templates.add", { ...base, text: "   " }), /没有读到范本正文/);
  await assert.rejects(inv("firm_templates.add", { ...base, title: "丁贸易有限公司专用", text: TEMPLATE_TEXT }), (e: any) => e.code === "validation" && /丁贸易有限公司/.test(e.message));
  await assert.rejects(inv("firm_templates.add", { ...base, data_base64: Buffer.from("x").toString("base64"), filename: "范本.pdf" }), (e: any) => e.code === "unsupported_file");

  const dirty = `${TEMPLATE_TEXT}\n第十三条 通知\n通知送达丁贸易有限公司，联系人电话 13900139000。`;
  const r1 = await inv("firm_templates.add", { ...base, text: dirty });
  assert.equal(r1.status, "needs_cleanup");
  assert.deepEqual(r1.hits.map((h: any) => [h.heading, h.kind, h.text]), [["第十三条 通知", "party", "丁贸易有限公司"], ["第十三条 通知", "phone", "13900139000"]]);
  assert.equal((await inv("firm_templates.list")).templates.length, 0, "查到客户信息时不保存");

  const r2 = await inv("firm_templates.add", { ...base, text: dirty, replace_hits: true });
  assert.equal(r2.status, "saved");
  assert.equal(r2.replaced, 2);
  assert.equal(r2.template.clauses, 5, "首部不计条数");
  const got = await inv("firm_templates.get", { template_id: r2.template.template_id });
  assert.equal(got.clauses.at(-1).text, "第十三条 通知\n通知送达【当事人】，联系人电话 【电话】。");

  // Word 文件放入
  const docx = createDocx("租赁合同范本", [{ heading: "第三条 租金", paragraphs: ["承租人应于每季度首月十日前支付当季租金。"] }]);
  const r3 = await inv("firm_templates.add", { title: "房屋租赁（出租方版）", contract_type: "租赁", stance: "出租方", data_base64: docx.toString("base64"), filename: "租赁范本.docx" });
  assert.equal(r3.status, "saved", JSON.stringify(r3));
  assert.equal(r3.template.source_name, "租赁范本.docx");
  const list = await inv("firm_templates.list");
  assert.deepEqual(list.templates.map((t: any) => t.title).sort(), ["房屋租赁（出租方版）", "采购合同（买方版）"]);
  assert.ok(list.contract_types.includes("买卖"));

  // 审计只记编号与摘要，不记正文
  const audits = JSON.stringify(kernel.db.all(`SELECT * FROM audit_events WHERE action LIKE 'firm_template.%'`));
  assert.match(audits, /firm_template\.added/);
  assert.doesNotMatch(audits, /验收合格|租金|采购合同/);

  await inv("firm_templates.remove", { template_id: r3.template.template_id });
  assert.equal((await inv("firm_templates.list")).templates.length, 1);
  assert.equal(kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM firm_template_clauses WHERE template_id = ?`, [r3.template.template_id])!.n, 0, "条款一并删除");
  await assert.rejects(inv("firm_templates.get", { template_id: r3.template.template_id }), (e: any) => e.code === "not_found");
});

test("审合同卡片的本所范本：付款卡列出范本的付款条款、保密缺失卡列出保密条款；立场不同标出；不相关的不列；范本库为空时为空", async () => {
  const { inv, kernel } = tk;
  const tid = kernel.identity.tenantId;
  const { matter } = await inv("matters.create", { title: "范本比对", stance: "卖方", consent_status: "agreed" });
  const m = matter.matter_id;
  const doc = await importBytes(inv, m, "采购合同.docx", createDocx("采购合同", [{ heading: "第八条", paragraphs: ["8.1 买方应于验收合格后九十日内支付货款。"] }]), DOCX);
  const live = liveTaskIdentity(tk, m, "tplmatch");
  submitRiskCards({ db: kernel.db, blobs: kernel.blobs }, { tenantId: live.tid, matterId: m, runId: live.rid }, {
    document_version_id: doc.document_version_id,
    cards: [
      { anchor_text: "买方应于验收合格后九十日内支付货款。", severity: "mid", category: "commercial", issue: "【权利义务】付款期限过长", suggestion: "买方应于验收合格后六十日内支付货款。" },
      { kind: "missing", anchor_text: "买方应于验收合格后九十日内支付货款。", severity: "mid", category: "legal", issue: "缺少保密条款", suggestion: "双方对知悉的对方商业秘密负保密义务。", searched_terms: ["保密", "商业秘密"] },
      { anchor_text: "买方应于验收合格后九十日内支付货款。", severity: "low", category: "commercial", issue: "发票开具时间未约定", suggestion: null },
    ],
  });
  const cards = (await inv("riskcards.list", { matter_id: m })).cards;
  const byIssue = (re: RegExp) => cards.find((c: any) => re.test(c.issue))!;
  const pay = await inv("firm_templates.for_card", { matter_id: m, card_id: byIssue(/付款期限/).card_id });
  assert.equal(pay.library_size, 1);
  assert.equal(pay.items[0].heading, "第五条 付款", JSON.stringify(pay.items));
  assert.equal(pay.items[0].stance_differs, true, "买方范本对卖方事项标立场不同");
  assert.equal(pay.items[0].same_type, true, "材料初判为买卖合同");
  const conf = await inv("firm_templates.for_card", { matter_id: m, card_id: byIssue(/保密/).card_id });
  assert.equal(conf.items[0]?.heading, "第十二条 保密", JSON.stringify(conf.items));
  assert.ok(pay.items.length <= 3 && pay.items.every((x: any) => x.seq > 0), "首部不参与比对");
  assert.ok(!pay.items.some((x: any) => x.heading === "第十二条 保密"), "不相关的条款不列");
  await assert.rejects(inv("firm_templates.for_card", { matter_id: m, card_id: "rkc_nope" }), (e: any) => e.code === "not_found");
  // 纯函数：代号与条号不参与比对；库为空返回空
  assert.deepEqual(matchClauses(kernel.db, "ten_nobody", { text: "付款", contract_type: null, stance: null }), []);
  assert.deepEqual(matchClauses(kernel.db, tid, { text: "〔甲方1〕 第五条", contract_type: null, stance: null }), []);
});
