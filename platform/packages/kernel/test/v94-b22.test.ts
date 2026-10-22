/**
 * v9.4 第 22 批（评审 C1 §1 #20、#21、#22、#4、#28、#29；主文 §8 条款页码续）：
 * - 事项模板：新建事项时选类型，预置阶段、待办、推荐的方法；起算日推出届满日（与 calc.deadline 同一计算）写进关键日期与待办；
 * - 本事项的审查要点：版本、并发保护、停用、AI 草稿（只存草稿、律师启用后才编号）；风险卡“要点 n”按任务快照核对、工作台附要点原文；
 * - 修订署名：这台电脑设置的作者名写进 Word 修订；
 * - 我的写作偏好：只存格式与文风，拦下像当事人名称、案号、金额的内容；
 * - 材料初判：本机按规则认文书类型、合同类型与篇幅；
 * - 引文页码：按页解析的材料里，格子与事实的引文给出第几页；
 * - 事项删除时审查要点一并删除。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, readZipEntries, readZipText } from "@zr-legal/docx-engine";
import { importBytes, importText, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { calcDeadline } from "../src/tools/tools/deadline.ts";
import { MATTER_TEMPLATES } from "../src/services/matter-templates.ts";
import { listRuleSets, proposeDraft, rulesPromptBlock, snapshotOf } from "../src/services/review-rules.ts";
import { listRiskCards, quotePages, submitRiskCards } from "../src/services/review-cards.ts";
import { caseLikeProblem, prefsPromptLine } from "../src/services/writing-prefs.ts";
import { triageText } from "../src/services/material-triage.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b22-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("事项模板：清单、创建时预置阶段与待办；起算日推出届满日写进关键日期与带期限的待办；校验", async () => {
  const { inv } = tk;
  const { templates } = await inv("matters.templates");
  assert.equal(templates.length, MATTER_TEMPLATES.length);
  assert.ok(templates.every((t: any) => t.stances.length > 0 && t.todos.length > 0 && t.scenarios.length > 0));

  const t = templates.find((x: any) => x.id === "lit-contract-defendant");
  const r = await inv("matters.create", { title: "模板应诉", stance: "被告", consent_status: "agreed", template_id: t.id, template_start: "2026-10-09" });
  const want = calcDeadline({ start: "2026-10-09", period: { unit: "day", n: 15 }, rule: "civil" }).deadline!;
  assert.equal(r.matter.template_id, "lit-contract-defendant");
  assert.equal(r.matter.stage, "first_instance", "阶段用模板的");
  assert.deepEqual(r.matter.key_dates, { 收到起诉状: "2026-10-09", 答辩期届满: want });
  assert.equal(r.template_applied.deadline.date, want);
  assert.ok(r.template_applied.deadline.steps.length > 0, "届满日附推算过程");
  const todos = await inv("todos.list", { matter_id: r.matter.matter_id });
  assert.equal(todos.open.length, t.todos.length + 1);
  const first = todos.open.find((x: any) => x.due_date);
  assert.equal(first.due_date, want);
  assert.match(first.title, /答辩期届满/);
  // 律师给的阶段、关键日期优先
  const r2 = await inv("matters.create", { title: "模板 2", stance: "被告", consent_status: "agreed", template_id: t.id, stage: "pre_filing", key_dates: { analysis_as_of: "2026-10-01" } });
  assert.equal(r2.matter.stage, "pre_filing");
  assert.deepEqual(r2.matter.key_dates, { analysis_as_of: "2026-10-01" }, "没给起算日不推届满日");
  assert.equal((await inv("todos.list", { matter_id: r2.matter.matter_id })).open.length, t.todos.length);
  // 校验：失败时不留半个事项
  const before = tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matters`)!.n;
  await assert.rejects(inv("matters.create", { title: "x", stance: "被告", template_id: "nope" }), (e: any) => e.code === "validation");
  await assert.rejects(inv("matters.create", { title: "x", stance: "被告", template_start: "2026-10-09" }), /没有选事项类型/);
  await assert.rejects(inv("matters.create", { title: "x", stance: "买方", template_id: "deal-contract", template_start: "2026-10-09" }), /不需要起算日期/);
  await assert.rejects(inv("matters.create", { title: "x", stance: "被告", template_id: t.id, template_start: "2026-02-30" }), /YYYY-MM-DD/);
  assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matters`)!.n, before);
  // 申请执行期间按年算；届满日落在节假日表未收录的年份，待办上写明须核对（复核 Q4-05）
  const e = await inv("matters.create", { title: "执行", stance: "申请人", consent_status: "agreed", template_id: "lit-enforcement", template_start: "2026-03-31" });
  assert.equal(e.matter.key_dates["申请执行期间届满"], calcDeadline({ start: "2026-03-31", period: { unit: "year", n: 2 }, rule: "civil" }).deadline);
  assert.equal(e.template_applied.deadline.uncertain, true);
  assert.match((await inv("todos.list", { matter_id: e.matter.matter_id })).open.find((x: any) => x.due_date).title, /须按当年放假通知核对/);
  assert.doesNotMatch(first.title, /须按当年放假通知核对/, "2026 年已收录的不写");
  // 起算日不能晚于今天
  await assert.rejects(inv("matters.create", { title: "x", stance: "被告", template_id: t.id, template_start: "2099-01-01" }), /不能晚于今天/);
});

test("审查要点：保存出新版、旧版取代；并发保护；校验；停用；AI 草稿只存草稿、同任务取代、启用后才编号", async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "要点", stance: "买方", consent_status: "agreed" });
  const m = matter.matter_id;
  assert.equal((await inv("review_rules.get", { matter_id: m })).active, null);
  const rules = [{ topic: "付款", standard: "验收合格后六十日内付款", fallback: "不超过九十日" }, { topic: "违约金", standard: "不超过合同总价 20%", red_line: "不接受无上限违约金" }];
  const v1 = (await inv("review_rules.save", { matter_id: m, title: "客户甲采购标准", rules, base_version: null })).saved;
  assert.equal(v1.version, 1);
  assert.deepEqual(v1.rules.map((r: any) => r.no), [1, 2]);
  assert.equal(v1.rules[0].red_line, null);
  // 内容没变不出新版
  assert.equal((await inv("review_rules.save", { matter_id: m, title: "客户甲采购标准", rules, base_version: 1 })).saved.version, 1);
  await assert.rejects(inv("review_rules.save", { matter_id: m, title: "x", rules, base_version: null }), (e: any) => e.code === "conflict", "别处已经存了第 1 版");
  const v2 = (await inv("review_rules.save", { matter_id: m, title: "客户甲采购标准", rules: [...rules, { topic: "管辖", standard: "我方所在地法院" }], base_version: 1 })).saved;
  assert.equal(v2.version, 2);
  let l = await inv("review_rules.get", { matter_id: m });
  assert.equal(l.active.version, 2);
  assert.deepEqual(l.history.map((h: any) => [h.version, h.status]), [[1, "superseded"]]);
  for (const bad of [{ title: "", rules }, { title: "x", rules: [] }, { title: "x", rules: [{ topic: "付款" }] }, { title: "x", rules: Array.from({ length: 41 }, () => ({ topic: "a", standard: "b" })) }, { title: "x", rules: [{ topic: "a", standard: "字".repeat(301) }] }])
    await assert.rejects(inv("review_rules.save", { matter_id: m, ...bad }), (e: any) => e.code === "validation", JSON.stringify(bad).slice(0, 60));

  // AI 草稿：没有版本号、不是在用的；同一任务再交取代上一份；启用后编号为下一版
  const live = liveTaskIdentity(tk, m, "rules");
  const scope = { tenantId: live.tid, matterId: m, runId: live.rid };
  proposeDraft(tk.kernel.db, scope, { title: "范本整理（草稿）", rules: [{ topic: "付款", standard: "验收后三十日" }] });
  const d = proposeDraft(tk.kernel.db, scope, { title: "范本整理（草稿）", rules: [{ topic: "付款", standard: "验收后四十五日" }] });
  assert.throws(() => proposeDraft(tk.kernel.db, { ...scope, runId: null }, { title: "x", rules: [{ topic: "a", standard: "b" }] }), (e: any) => e.code === "forbidden");
  l = await inv("review_rules.get", { matter_id: m });
  assert.equal(l.drafts.length, 1, "同一任务再交取代上一份");
  assert.equal(l.drafts[0].version, null);
  assert.equal(l.drafts[0].source, "ai_draft");
  assert.equal(l.active.version, 2, "草稿不影响在用的一版");
  const v3 = (await inv("review_rules.save", { matter_id: m, title: "范本整理", rules: l.drafts[0].rules, from_draft: d.rule_set_id, base_version: 2 })).saved;
  assert.equal(v3.version, 3);
  l = await inv("review_rules.get", { matter_id: m });
  assert.equal(l.drafts.length, 0, "启用后草稿去掉");
  await assert.rejects(inv("review_rules.save", { matter_id: m, title: "x", rules, from_draft: d.rule_set_id }), (e: any) => e.code === "not_found");
  // 草稿至多 5 份
  for (let i = 0; i < 5; i++) proposeDraft(tk.kernel.db, { ...scope, runId: liveTaskIdentity(tk, m, `r${i}`).rid }, { title: `草稿 ${i}`, rules: [{ topic: "a", standard: "b" }] });
  assert.throws(() => proposeDraft(tk.kernel.db, { ...scope, runId: liveTaskIdentity(tk, m, "r6").rid }, { title: "x", rules: [{ topic: "a", standard: "b" }] }), (e: any) => e.code === "conflict");
  const one = (await inv("review_rules.get", { matter_id: m })).drafts[0];
  assert.equal((await inv("review_rules.discard_draft", { matter_id: m, rule_set_id: one.rule_set_id })).drafts.length, 4);
  // 停用
  assert.equal((await inv("review_rules.retire", { matter_id: m })).active, null);
  assert.equal(listRuleSets(tk.kernel.db, m).history[0]!.status, "retired");
});

test("风险卡与审查要点：按任务快照核对“要点 n”；工作台附那一版要点原文；没有快照不许写要点", async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "要点卡", stance: "买方", consent_status: "agreed" });
  const m = matter.matter_id;
  const doc = await importBytes(inv, m, "采购合同.docx", createDocx("采购合同", [{ heading: "第八条", paragraphs: ["8.1 买方应于验收合格后九十日内支付货款。"] }]), DOCX);
  const saved = (await inv("review_rules.save", { matter_id: m, title: "采购标准", rules: [{ topic: "付款", standard: "验收合格后六十日内付款", fallback: "不超过七十五日" }] })).saved;
  const live = liveTaskIdentity(tk, m, "rcard");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ review_rules: snapshotOf(saved) }), live.rid]);
  const scope = { tenantId: live.tid, matterId: m, runId: live.rid };
  const deps = { db: tk.kernel.db, blobs: tk.kernel.blobs };
  const card = { kind: "deviation", rule_source: "firm_rule", anchor_text: "买方应于验收合格后九十日内支付货款。", severity: "mid", category: "commercial", issue: "【权利义务】付款期限长于要点" };
  // 本所覆盖层或任务说明另给的规则不写“要点 n”，照常接受（复核 Q4-03）
  submitRiskCards(deps, scope, { document_version_id: doc.document_version_id, cards: [{ ...card, issue: "【权利义务】按覆盖层", rule_ref: "R-12 付款期限不超过 60 日" }] });
  assert.throws(() => submitRiskCards(deps, scope, { document_version_id: doc.document_version_id, cards: [{ ...card, rule_ref: "要点 2：付款" }] }), /只有 1 条，没有要点 2/);
  submitRiskCards(deps, scope, { document_version_id: doc.document_version_id, cards: [{ ...card, rule_ref: "要点 1：付款" }] });
  // 之后改了要点，卡片仍显示任务当时那一版
  await inv("review_rules.save", { matter_id: m, title: "采购标准", rules: [{ topic: "付款", standard: "验收合格后三十日内付款" }] });
  const c = listRiskCards(tk.kernel.db, m, { run_id: live.rid }).find((x) => x.rule_ref?.startsWith("要点"))!;
  assert.equal(listRiskCards(tk.kernel.db, m, { run_id: live.rid }).find((x) => x.rule_ref?.startsWith("R-12"))?.rule_text, undefined, "不是要点的不附要点原文");
  assert.equal(c.rule_text?.version, 1);
  assert.equal(c.rule_text?.standard, "验收合格后六十日内付款");
  assert.equal(c.rule_text?.fallback, "不超过七十五日");
  // 没有快照的任务：不许写“要点 n”；不写要点的偏离卡照旧
  const live2 = liveTaskIdentity(tk, m, "rcard2");
  const scope2 = { tenantId: live2.tid, matterId: m, runId: live2.rid };
  assert.throws(() => submitRiskCards(deps, scope2, { document_version_id: doc.document_version_id, cards: [{ ...card, rule_ref: "要点 1：付款" }] }), /没有本事项审查要点/);
  submitRiskCards(deps, scope2, { document_version_id: doc.document_version_id, cards: [{ ...card, issue: "【权利义务】另一张", rule_ref: "R-12 付款期限不超过 60 日" }] });
  // 发给 Agent 的一段
  const block = rulesPromptBlock(snapshotOf(saved));
  assert.match(block, /【本事项审查要点 第 1 版「采购标准」/);
  assert.match(block, /1\. 付款：我方标准：验收合格后六十日内付款；可退让：不超过七十五日/);
  assert.match(block, /rule_ref 写“要点 n：条款”/);
});

test("发起任务：审合同的方法缺省快照在用的审查要点；review_rules:false 不用；其他方法不带；写作偏好快照进任务输入", async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "快照", stance: "买方", consent_status: "not_required" });
  const m = matter.matter_id;
  const snap = (runId: string) => JSON.parse(tk.kernel.db.get<{ input_snapshot: string }>(`SELECT input_snapshot FROM runs WHERE run_id = ?`, [runId])!.input_snapshot);
  const start = async (extra: Record<string, unknown>) => {
    const est = await inv("runs.estimate", { matter_id: m, scenario: "a1.agent_task", document_version_ids: [] });
    const r = await inv("runs.start", { matter_id: m, estimate_id: est.estimate_id, idempotency_key: `b22-${Math.random()}`, goal: "审一下", plan_first: false, mode: "default", ...extra });
    // 只看快照：发起后即取消（同一事项同时只能有一个进行中的任务）
    const v = tk.kernel.db.get<{ status_version: number }>(`SELECT status_version FROM runs WHERE run_id = ?`, [r.run_id])!.status_version;
    await inv("runs.cancel", { run_id: r.run_id, expected_version: v, reason: "用例" }).catch(() => {});
    return r.run_id as string;
  };
  await assert.rejects(start({ skill: "contract-review", review_rules: true }), /还没有在用的审查要点/);
  await inv("review_rules.save", { matter_id: m, title: "采购标准", rules: [{ topic: "付款", standard: "六十日" }] });
  await inv("writing_prefs.set", { signature: "某某律师事务所 张律师", citation: "short" });
  const a = snap(await start({ skill: "contract-review" }));
  assert.equal(a.review_rules.version, 1);
  assert.equal(a.review_rules.rules[0].standard, "六十日");
  assert.deepEqual(a.writing_prefs, { signature: "某某律师事务所 张律师", citation: "short", notes: null });
  assert.equal(snap(await start({ skill: "contract-review", review_rules: false })).review_rules, undefined);
  assert.equal(snap(await start({ skill: "citation-check" })).review_rules, undefined, "不按要点审的方法不带");
  await assert.rejects(start({ skill: "citation-check", review_rules: true }), /不按审查要点审/);
  await assert.rejects(start({ skill: "contract-review", review_rules: "yes" }), /true \/ false/);
  await inv("writing_prefs.set", {});
  assert.equal(snap(await start({})).writing_prefs, undefined, "没设偏好不带");
});

test("我的写作偏好：读写、清空；拦下像案号、金额、证件号、当事人名称的内容（落款不按当事人名称拦）；发给 Agent 的一行", async () => {
  const { inv } = tk;
  await inv("matters.create", { title: "偏好", stance: "买方", client_name: "丙科技有限公司", counterparty: "丁贸易有限公司", consent_status: "agreed" });
  assert.deepEqual(await inv("writing_prefs.get"), { signature: null, citation: null, notes: null });
  const p = await inv("writing_prefs.set", { signature: "某某律师事务所 李律师", citation: "full", notes: "标题用黑体；段首空两格" });
  assert.equal(p.citation, "full");
  assert.deepEqual(await inv("writing_prefs.get"), p);
  for (const [notes, re] of [["参照（2024）沪0101民初123号的写法", /案号/], ["违约金按 50 万元写", /金额/], ["对丁贸易有限公司要强硬", /当事人名称（丁贸易有限公司）/], ["联系人 13800138000", /证件号或电话/]] as const)
    await assert.rejects(inv("writing_prefs.set", { notes }), (e: any) => e.code === "validation" && re.test(e.message), notes);
  await assert.rejects(inv("writing_prefs.set", { citation: "x" }), (e: any) => e.code === "validation");
  await assert.rejects(inv("writing_prefs.set", { notes: "字".repeat(201) }), /至多 200 字/);
  assert.equal(caseLikeProblem("落款写本所", ["本所"]), "出现了你事项里的当事人名称（本所）");
  assert.match(prefsPromptLine(p), /文书落款写“某某律师事务所 李律师”；法条每次写全称.*其他：标题用黑体/);
  assert.equal(prefsPromptLine({ signature: null, citation: null, notes: null }), "");
  await inv("writing_prefs.set", { signature: "", notes: null });
  assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM user_writing_prefs`)!.n, 0, "全空即删除");
});

test("修订署名：这台电脑设置的作者名写进 Word 修订；不设用缺省；超长拒绝；旧调用不清掉", async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "署名", stance: "买方", consent_status: "agreed" });
  const m = matter.matter_id;
  const doc = await importBytes(inv, m, "采购合同.docx", createDocx("采购合同", [{ heading: "第八条", paragraphs: ["8.1 买方应于验收合格后九十日内支付货款。"] }]), DOCX);
  const live = liveTaskIdentity(tk, m, "author");
  submitRiskCards({ db: tk.kernel.db, blobs: tk.kernel.blobs }, { tenantId: live.tid, matterId: m, runId: live.rid }, { document_version_id: doc.document_version_id, cards: [{ anchor_text: "买方应于验收合格后九十日内支付货款。", severity: "mid", category: "commercial", issue: "【权利义务】付款期限", suggestion: "买方应于验收合格后六十日内支付货款。" }] });
  const card = (await inv("riskcards.list", { matter_id: m })).cards[0];
  await inv("riskcards.decide", { matter_id: m, card_id: card.card_id, decision: "accept" });
  const authorOf = async () => {
    const red = await inv("riskcards.redline", { matter_id: m, document_version_id: doc.document_version_id, audience: "external" });
    assert.equal(red.status, "applied", JSON.stringify(red));
    const xml = readZipText(Buffer.from((await inv("artifacts.download", { artifact_version_id: red.artifact_version_id, restore: false })).data_base64, "base64"), "word/document.xml")!;
    return /<w:ins [^>]*w:author="([^"]+)"/.exec(xml)?.[1];
  };
  assert.equal(await authorOf(), "律师审定（Kimi Work 辅助起草）");
  assert.equal((await inv("doc_style.set", { letterhead: "auto", redline_author: "某某律师事务所 王律师" })).redline_author, "某某律师事务所 王律师");
  assert.equal(await authorOf(), "某某律师事务所 王律师");
  // 没带 redline_author 的旧调用不清掉
  assert.equal((await inv("doc_style.set", { letterhead: "auto" })).redline_author, "某某律师事务所 王律师");
  await assert.rejects(inv("doc_style.set", { redline_author: "字".repeat(31) }), /至多 30 字/);
  assert.equal((await inv("doc_style.set", { redline_author: "" })).redline_author, null);
});

test("材料初判：文书类型、合同类型、篇幅；证据里提到“合同”不当成合同；接口只列解析出文字的材料", async () => {
  const t = (name: string, head: string) => triageText(name, head, head.length, null);
  assert.deepEqual([t("采购合同.docx", "采购合同\n甲方：").kind, t("采购合同.docx", "").contract_type], ["contract", "买卖"]);
  assert.equal(t("补充协议（二）.docx", "").kind, "supplement");
  assert.equal(t("股权转让协议.docx", "").contract_type, "股权转让");
  assert.equal(t("增资协议.docx", "").contract_type, "投资协议（增资 / 股权收购）");
  assert.equal(t("材料1.pdf", "民事起诉状\n原告：").kind, "complaint");
  assert.equal(t("材料2.pdf", "上海市某区人民法院\n民事判决书\n（2025）沪0101民初123号").kind, "judgment_first");
  assert.equal(t("材料3.pdf", "上海市第一中级人民法院\n民事判决书\n（2025）沪01民终456号").kind, "judgment_final");
  assert.equal(t("材料4.pdf", "某仲裁委员会\n裁决书").kind, "award");
  assert.equal(t("申请书.pdf", "劳动人事争议仲裁申请书\n申请人：").kind, "labor_application");
  assert.equal(t("员工手册.docx", "").kind, "policy");
  assert.equal(t("2025年股东会决议.pdf", "").kind, "corporate");
  assert.equal(t("发票.pdf", "增值税专用发票\n备注：依据双方签订的采购合同第三条").kind, "other", "证据正文提到合同不算合同");
  assert.equal(t("律师函.docx", "").kind, "letter");
  // 复核 Q4-04 的五个样本：诉状、申请书正文开头提到判决、裁决、调解书，不能认成判决书等；证据目录不是合同
  assert.equal(t("上诉状.pdf", "民事上诉状\n上诉人（原审被告）：甲公司\n被上诉人（原审原告）：乙公司\n上诉人因与被上诉人买卖合同纠纷一案，不服北京市朝阳区人民法院（2025）京0105民初123号民事判决书，现提起上诉。").kind, "appeal");
  assert.equal(t("起诉状.docx", "民事起诉状\n原告：张三\n被告：某公司\n诉讼请求：\n原告不服北京市朝阳区劳动人事争议仲裁委员会京朝劳人仲字[2025]第1号仲裁裁决书，现起诉。").kind, "complaint");
  assert.equal(t("答辩状.docx", "民事答辩状\n答辩人：某公司\n答辩人就原告诉答辩人一案，针对起诉状及（2024）京01民终5号民事判决书...").kind, "defense");
  assert.equal(t("强制执行申请书.pdf", "强制执行申请书\n申请执行人：甲\n被执行人：乙\n申请执行依据：（2025）京0105民初1号民事调解书").kind, "application");
  assert.deepEqual([t("证据目录.pdf", "证据目录\n证据一：采购合同\n证据二：发票").kind, t("材料.pdf", "证据一：采购合同\n证据二：发票").kind], ["evidence_list", "other"]);
  assert.equal(triageText("a.txt", "", 25_000, 12).size, "long");
  assert.equal(triageText("a.txt", "", 800, null).size, "short");

  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "初判", stance: "被告", consent_status: "agreed" });
  await importText(inv, matter.matter_id, "起诉状.txt", "民事起诉状\n原告：甲公司\n诉讼请求：……");
  await importBytes(inv, matter.matter_id, "租赁合同.docx", createDocx("房屋租赁合同", [{ heading: "第一条", paragraphs: ["出租人将房屋出租给承租人。"] }]), DOCX);
  const items = (await inv("materials.triage", { matter_id: matter.matter_id })).items;
  assert.deepEqual(items.map((i: any) => [i.label, i.contract_type]).sort(), [["合同", "租赁"], ["起诉状", null]]);
});

test("引文页码：按页解析的材料给出第几页（引文唯一才算）；Word 不给；事实与格子接口带上页码", async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "页码", stance: "原告", consent_status: "agreed" });
  const m = matter.matter_id;
  const pdfLike = await importText(inv, m, "证据.txt", "第一页：双方签订合同。\f第二页：买方于 2026 年 3 月 1 日签收全部货物。\f第三页：签收人张三。");
  const word = await importBytes(inv, m, "合同.docx", createDocx("合同", [{ heading: "一", paragraphs: ["买方于 2026 年 3 月 1 日签收全部货物。"] }]), DOCX);
  const deps = { db: tk.kernel.db, blobs: tk.kernel.blobs };
  const pages = quotePages(deps, m, [
    { key: "a", document_version_id: pdfLike.document_version_id, quote: "签收人张三。" },
    { key: "b", document_version_id: pdfLike.document_version_id, quote: "买方于 2026 年 3 月 1 日签收全部货物。" },
    { key: "c", document_version_id: pdfLike.document_version_id, quote: "第" },
    { key: "d", document_version_id: word.document_version_id, quote: "买方于 2026 年 3 月 1 日签收全部货物。" },
  ]);
  assert.equal(pages.get("a"), 3);
  assert.equal(pages.get("b"), 2);
  assert.equal(pages.has("c"), false, "出现多处不给页码");
  assert.equal(pages.has("d"), false, "Word 没有版面页码");
  // 事实接口带页码
  const live = liveTaskIdentity(tk, m, "page");
  const { submitFacts } = await import("../src/services/review-cards.ts");
  submitFacts(deps, { tenantId: live.tid, matterId: m, runId: live.rid }, { facts: [{ statement: "买方签收全部货物", kind: "claimed", occurred_on: "2026-03-01", document_version_id: pdfLike.document_version_id, quote: "买方于 2026 年 3 月 1 日签收全部货物。" }] });
  const f = (await inv("facts.list", { matter_id: m })).facts[0];
  assert.equal(f.page, 2);
  // 格子接口带页码
  const table = (await inv("tables.create", { matter_id: m, template: "evidence_list", document_version_ids: [pdfLike.document_version_id] })).table;
  const col = table.columns[0].key;
  const { fillCells } = await import("../src/services/review-tables.ts");
  fillCells(deps, { matterId: m, runId: live.rid }, { table_id: table.table_id, cells: [{ document_version_id: pdfLike.document_version_id, column: col, value: "张三", quote: "签收人张三。" }] });
  const cell = (await inv("tables.get", { matter_id: m, table_id: table.table_id })).cells.find((c: any) => c.col_key === col);
  assert.equal(cell.page, 3);
});

test("事项删除时审查要点一并删除；归档包里有审查要点", async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "删除要点", stance: "买方", consent_status: "agreed" });
  const m = matter.matter_id;
  await inv("review_rules.save", { matter_id: m, title: "金丝雀标准", rules: [{ topic: "付款", standard: "金丝雀B22" }] });
  const zip = readZipEntries(Buffer.from((await inv("matters.archive", { matter_id: m })).data_base64, "base64"));
  const inArchive = JSON.parse(zip.get("review/review-rules.json")!.toString("utf8"));
  assert.equal(inArchive[0].rules[0].standard, "金丝雀B22");
  await inv("matters.close", { matter_id: m, retention_years: 1 });
  await inv("matters.purge", { matter_id: m, confirm_title: "删除要点", early: true, reason: "用例" });
  assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matter_review_rules WHERE matter_id = ?`, [m])!.n, 0);
});

test("法规库状态写明节假日表是随法规库更新的还是应用内置的（偏离 D-128 回归计划）", async () => {
  const st = await tk.inv("lawdb.status");
  assert.ok(["package", "builtin"].includes(st.holidays.from));
  assert.ok(st.holidays.years.includes(2026));
  assert.match(st.display, /节假日表 \d{4}—\d{4} 年（(随法规库更新|应用内置)）/);
});

// ─── 独立复核 Q4 处置 ───

test("Q4-01：写作偏好按事项令牌词典查当事人（简称、别名也拦）；落款也查；中文金额、货币符号、方括号案号也拦", async () => {
  const { inv } = tk;
  await inv("matters.create", { title: "偏好别名", stance: "买方", client_name: "庚星科技有限公司", consent_status: "agreed" });
  for (const [field, text, re] of [
    ["notes", "对庚星科技语气要强硬", /当事人/],
    ["signature", "代理庚星科技有限公司 张律师", /当事人/],
    ["notes", "标的金额五十万元以上的写详细", /金额/],
    ["notes", "合同金额写成￥1,000.00", /金额/],
    ["notes", "参照京劳人仲字[2025]第1号的写法", /案号/],
  ] as const)
    await assert.rejects(inv("writing_prefs.set", { [field]: text }), (e: any) => e.code === "validation" && re.test(e.message), text);
  // 本所名称与律师姓名不是当事人：落款照常保存
  assert.equal((await inv("writing_prefs.set", { signature: "某某律师事务所 张律师" })).signature, "某某律师事务所 张律师");
  await inv("writing_prefs.set", {});
});

test("Q4-02：隔离带密级标志的材料时，用过它的任务起草的审查要点草稿删除、据此启用的版本清除内容并停用、任务快照里的要点清空", { timeout: 60_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "隔离要点", stance: "买方", consent_status: "agreed" });
  const m = matter.matter_id;
  const tpl = await inv("materials.import", { matter_id: m, filename: "范本.txt", data_base64: Buffer.from("采购范本：验收后六十日付款 金丝雀KWL-Q402").toString("base64"), mime: "text/plain" });
  const live = liveTaskIdentity(tk, m, "q402");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ document_version_ids: [tpl.document_version_id], skill: "review-rules-draft" }), live.rid]);
  const scope = { tenantId: live.tid, matterId: m, runId: live.rid };
  const d1 = proposeDraft(tk.kernel.db, scope, { title: "范本整理", rules: [{ topic: "付款", standard: "验收后六十日 金丝雀KWL-Q402" }] });
  const v1 = (await inv("review_rules.save", { matter_id: m, title: "范本整理", rules: [{ topic: "付款", standard: "验收后六十日 金丝雀KWL-Q402" }], from_draft: d1.rule_set_id })).saved;
  assert.equal(v1.from_run_id, live.rid, "启用的版本记下起草它的任务");
  // 律师在此基础上改了一版：来源沿用
  const v2 = (await inv("review_rules.save", { matter_id: m, title: "范本整理", rules: [{ topic: "付款", standard: "验收后七十日 金丝雀KWL-Q402" }], base_version: 1 })).saved;
  assert.equal(v2.from_run_id, live.rid);
  proposeDraft(tk.kernel.db, scope, { title: "又一份", rules: [{ topic: "违约金", standard: "金丝雀KWL-Q402" }] });
  // 另一个任务快照了第 2 版
  const other = liveTaskIdentity(tk, m, "q402b");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ review_rules: snapshotOf(v2) }), other.rid]);
  // 重新解析看到密级标志 → 隔离
  const put = tk.kernel.blobs.put(Buffer.from("机密★1年\n采购范本：验收后六十日付款 金丝雀KWL-Q402"), m);
  tk.kernel.db.run(`UPDATE document_versions SET sha256 = ?, storage_uri = ? WHERE document_version_id = ?`, [put.sha256, put.storage_uri, tpl.document_version_id]);
  await assert.rejects(inv("materials.reparse", { document_version_id: tpl.document_version_id }), (e: any) => e.code === "classified_material");
  const l = await inv("review_rules.get", { matter_id: m });
  assert.equal(l.active, null, "在用的那一版停用，不再快照进新任务");
  assert.equal(l.drafts.length, 0);
  assert.ok(l.history.every((h: any) => h.rules.length === 0 && /已隔离/.test(h.title)));
  const leaked = tk.kernel.db.all(`SELECT title, rules FROM matter_review_rules WHERE matter_id = ?`, [m]).concat(tk.kernel.db.all(`SELECT input_snapshot FROM runs WHERE matter_id = ?`, [m]));
  assert.equal(JSON.stringify(leaked).includes("KWL-Q402"), false, "库里的要点与任务快照不再有那份材料的内容");
});

test("Q4-08、Q4-09、建议 1：追问不能另选要点；停用核对版本；每个事项只有一版在用；只有“从范本整理”的任务能起草要点", async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "复核杂项", stance: "买方", consent_status: "not_required" });
  const m = matter.matter_id;
  const est = await inv("runs.estimate", { matter_id: m, scenario: "a1.agent_task", document_version_ids: [] });
  await assert.rejects(inv("runs.start", { matter_id: m, estimate_id: est.estimate_id, idempotency_key: `q408-${Date.now()}`, goal: "追问", skill: "contract-review", followup_of: "run_x", review_rules: false }), /追问沿用原任务的审查要点/);
  await inv("review_rules.save", { matter_id: m, title: "标准", rules: [{ topic: "付款", standard: "六十日" }] });
  await assert.rejects(inv("review_rules.retire", { matter_id: m, base_version: null }), (e: any) => e.code === "conflict");
  assert.throws(() => tk.kernel.db.run(`INSERT INTO matter_review_rules (rule_set_id, tenant_id, matter_id, version, title, rules, sha256, status, source, created_by, created_at) VALUES ('rrs_x', 't', ?, 99, 'x', '[]', 'x', 'active', 'lawyer', 'u', 'now')`, [m]), /UNIQUE/);
  assert.equal((await inv("review_rules.retire", { matter_id: m, base_version: 1 })).active, null);
  const { rulesPropose } = await import("../src/tools/tools/review.ts");
  const live = liveTaskIdentity(tk, m, "rp");
  const ctx = (skill: string) => {
    tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ skill }), live.rid]);
    return { claims: { tid: live.tid, mid: m, rid: live.rid }, db: tk.kernel.db } as any;
  };
  assert.throws(() => rulesPropose(ctx("contract-review"), { title: "x", rules: [{ topic: "a", standard: "b" }] }), (e: any) => e.code === "forbidden");
  assert.equal(rulesPropose(ctx("review-rules-draft"), { title: "x", rules: [{ topic: "a", standard: "b" }] }).rules, 1);
});

test("Q4-11：新接口的权限——结案只读、移出成员后读写都拒绝", async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "权限", stance: "买方", consent_status: "agreed" });
  const m = matter.matter_id;
  await inv("review_rules.save", { matter_id: m, title: "标准", rules: [{ topic: "付款", standard: "六十日" }] });
  await inv("matters.close", { matter_id: m, retention_years: 1 });
  assert.equal((await inv("review_rules.get", { matter_id: m })).active.version, 1, "结案后仍可看");
  for (const [method, params] of [["review_rules.save", { title: "x", rules: [{ topic: "a", standard: "b" }] }], ["review_rules.retire", {}], ["review_rules.discard_draft", { rule_set_id: "rrs_x" }]] as const)
    await assert.rejects(inv(method, { matter_id: m, ...params }), (e: any) => e.code === "conflict", `${method} 结案后拒绝`);
  tk.kernel.db.run(`UPDATE matter_members SET removed_at = CURRENT_TIMESTAMP WHERE matter_id = ?`, [m]);
  for (const method of ["review_rules.get", "materials.triage"]) await assert.rejects(inv(method, { matter_id: m }), (e: any) => ["forbidden", "not_found"].includes(e.code), `${method} 非成员拒绝`);
});

test("Q4-11：节假日表来源随法规库包换用而变（不是两种取值都放行）", async () => {
  const { useSignedHolidays, CN_HOLIDAYS } = await import("../src/tools/tools/cn-holidays.ts");
  useSignedHolidays([], "");
  assert.equal((await tk.inv("lawdb.status")).holidays.from, "builtin");
  useSignedHolidays([CN_HOLIDAYS.find((y) => y.year === 2026)], "测试包 1");
  const st = await tk.inv("lawdb.status");
  assert.equal(st.holidays.from, "package");
  assert.match(st.display, /节假日表 2024—2026 年（随法规库更新）/);
  useSignedHolidays([], "");
});

test("Q4-07：任务记录随团队事项同步时去掉发起人的写作偏好，审查要点快照保留", async () => {
  const { withoutWritingPrefs } = await import("../src/sync-engine.ts");
  const row = { run_id: "r", input_snapshot: JSON.stringify({ goal: "审一下", writing_prefs: { signature: "某所 张律师" }, review_rules: { version: 1 } }) };
  const out = JSON.parse(String(withoutWritingPrefs(row).input_snapshot));
  assert.equal(out.writing_prefs, undefined);
  assert.deepEqual(out.review_rules, { version: 1 });
  assert.equal(withoutWritingPrefs({ run_id: "r", input_snapshot: "{}" }).input_snapshot, "{}");
});
