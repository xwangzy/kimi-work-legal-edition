/**
 * v9.4 第 19 批 C-02 / C-05（评审 C1 §2.2）：风险卡四类（风险 / 缺失 / 偏离规则 / 前后不一致）、判断依据来源三分、
 * 缺失卡说清“查过哪些说法与文件”并由内核在材料里复查（找得到即标可能误报）、缺失条款以段后插入写进修订稿、
 * 谈判梯度可选用“可退让”一级（底线不能选）、修订稿分对外版（无批注）与内部版、导出审查意见表。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, extractParagraphs, readZipText } from "@zr-legal/docx-engine";
import { findTokens } from "@zr-legal/tokenizer";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { submitRiskCards } from "../src/services/review-cards.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "review-kinds-firm");
});
after(async () => {
  await tk.kernel.close();
});

async function setup(title: string) {
  const { matter } = await tk.inv("matters.create", { title, stance: "买方", consent_status: "agreed" });
  const main = createDocx("采购合同", [
    {
      heading: "第八条 付款",
      paragraphs: ["8.1 买方应于验收合格后九十日内支付货款。", "8.2 逾期付款的，按日万分之五支付违约金。"],
    },
    { heading: "第十二条 保密", paragraphs: ["12.1 双方对本合同内容负有保密义务。"] },
    { heading: "第十五条 争议解决", paragraphs: ["15.1 争议提交卖方所在地人民法院诉讼解决。"] },
  ]);
  const annex = createDocx("补充协议一", [{ heading: "第一条", paragraphs: ["1.1 卖方交付的工作成果的知识产权归买方所有。"] }]);
  const doc = await importBytes(tk.inv, matter.matter_id, "采购合同.docx", main, DOCX);
  const sup = await importBytes(tk.inv, matter.matter_id, "补充协议一.docx", annex, DOCX);
  const live = liveTaskIdentity(tk, matter.matter_id, "kinds");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "审查", document_version_ids: [doc.document_version_id, sup.document_version_id] }), live.rid]);
  const scope = { tenantId: live.tid, matterId: matter.matter_id, runId: live.rid };
  return { matter, doc, sup, live, scope, deps: { db: tk.kernel.db, blobs: tk.kernel.blobs } };
}

test("提交：四类卡入库；缺失卡必须列查过的说法、偏离卡必须写规则；内核复查找得到的说法标可能误报", { timeout: 60_000 }, async () => {
  const s = await setup("四类卡");
  const r = submitRiskCards(s.deps, s.scope, {
    document_version_id: s.doc.document_version_id,
    cards: [
      { kind: "deviation", rule_source: "firm_rule", rule_ref: "R-12 付款期限不超过六十日", anchor_text: "买方应于验收合格后九十日内支付货款。", severity: "high", category: "commercial", issue: "付款期限超出本所采购标准", suggestion: "买方应于验收合格后三十日内支付货款。", fallback: "买方应于验收合格后六十日内支付货款。", bottom_line: "六十日，逾期按 LPR 计息" },
      { kind: "missing", insert_after: "双方对本合同内容负有保密义务。", searched_terms: ["保密期限", "保密期间"], searched_docs: ["采购合同.docx", "补充协议一.docx"], severity: "mid", issue: "未约定保密期限", suggestion: "12.2 本条保密义务在本合同终止后五年内继续有效。" },
      { kind: "missing", searched_terms: ["知识产权", "成果归属"], severity: "mid", issue: "未找到知识产权归属条款", suggestion: "工作成果的知识产权归买方所有。" },
      { kind: "consistency", rule_source: "general", anchor_text: "按日万分之五支付违约金", severity: "low", issue: "违约金比例与第 8.1 条付款期限不匹配（示例）" },
    ],
  });
  assert.equal(r.submitted, 4);
  assert.deepEqual(r.cards.map((c: any) => c.anchor_status), ["located", "located", "not_found", "located"]);
  assert.deepEqual(r.cards[2]!.searched_found, ["知识产权"], "补充协议一里有“知识产权”：复查找到");
  assert.equal(r.cards[1]!.searched_found, undefined, "保密期限确实没有");
  assert.match(r.note, /可能误报/);
  const cards = (await tk.inv("riskcards.list", { matter_id: s.matter.matter_id })).cards as any[];
  const by = (k: string) => cards.filter((c) => c.kind === k);
  assert.equal(by("deviation")[0].rule_source, "firm_rule");
  assert.equal(by("deviation")[0].rule_ref, "R-12 付款期限不超过六十日");
  const missingIp = by("missing").find((c) => c.issue.includes("知识产权"));
  assert.deepEqual(missingIp.searched_found, [{ term: "知识产权", filename: "补充协议一.docx" }]);
  assert.deepEqual(by("missing").find((c) => c.issue.includes("保密")).searched_docs, ["采购合同.docx", "补充协议一.docx"]);
  assert.equal(by("consistency")[0].rule_source, "general");

  // 校验：缺失卡不列说法、偏离卡不写规则 → 拒绝整批
  assert.throws(() => submitRiskCards(s.deps, s.scope, { document_version_id: s.doc.document_version_id, cards: [{ kind: "missing", severity: "low", issue: "缺什么" }] }), /searched_terms/);
  assert.throws(() => submitRiskCards(s.deps, s.scope, { document_version_id: s.doc.document_version_id, cards: [{ kind: "deviation", anchor_text: "买方应于验收合格后九十日内支付货款。", severity: "low", issue: "偏离" }] }), /rule_ref/);
  // 偏离卡没写来源时按本所规则；普通风险卡（本批之前的卡）类型为 risk、来源为空
  submitRiskCards(s.deps, s.scope, { document_version_id: s.doc.document_version_id, cards: [{ kind: "deviation", rule_ref: "R-3 管辖须在我方所在地", anchor_text: "争议提交卖方所在地人民法院诉讼解决。", severity: "mid", issue: "管辖" }, { anchor_text: "逾期付款的", severity: "low", issue: "老卡" }] });
  const again = (await tk.inv("riskcards.list", { matter_id: s.matter.matter_id })).cards as any[];
  assert.equal(again.find((c) => c.rule_ref?.startsWith("R-3")).rule_source, "firm_rule");
  const old = again.find((c) => c.issue === "老卡");
  assert.equal(old.kind, "risk");
  assert.equal(old.rule_source, null);
});

test("梯度选用（C-05）：接受时选可退让，修订稿写可退让；底线不能选；没有可退让的卡不能选；只有“接受”能选", { timeout: 60_000 }, async () => {
  const s = await setup("梯度");
  submitRiskCards(s.deps, s.scope, {
    document_version_id: s.doc.document_version_id,
    cards: [
      { kind: "deviation", rule_ref: "R-12", anchor_text: "买方应于验收合格后九十日内支付货款。", severity: "high", category: "commercial", issue: "账期", suggestion: "买方应于验收合格后三十日内支付货款。", fallback: "买方应于验收合格后六十日内支付货款。", bottom_line: "七十五日" },
      { anchor_text: "争议提交卖方所在地人民法院诉讼解决。", severity: "mid", issue: "管辖", suggestion: "争议提交买方所在地人民法院诉讼解决。" },
    ],
  });
  const cards = (await tk.inv("riskcards.list", { matter_id: s.matter.matter_id })).cards as any[];
  const pay = cards.find((c) => c.issue === "账期");
  const venue = cards.find((c) => c.issue === "管辖");
  const m = s.matter.matter_id;
  await assert.rejects(tk.inv("riskcards.decide", { matter_id: m, card_id: pay.card_id, decision: "accept", level: "bottom_line" }), /底线只供参考/);
  await assert.rejects(tk.inv("riskcards.decide", { matter_id: m, card_id: venue.card_id, decision: "accept", level: "fallback" }), /没有可退让/);
  await assert.rejects(tk.inv("riskcards.decide", { matter_id: m, card_id: pay.card_id, decision: "modify", final_text: "x", level: "fallback" }), /只有“接受”/);
  const d = await tk.inv("riskcards.decide", { matter_id: m, card_id: pay.card_id, decision: "accept", level: "fallback" });
  assert.equal(d.card.chosen_level, "fallback");
  await tk.inv("riskcards.decide", { matter_id: m, card_id: venue.card_id, decision: "accept" });
  const pv = await tk.inv("riskcards.preview_redline", { matter_id: m, document_version_id: s.doc.document_version_id });
  const payPv = pv.cards.find((c: any) => c.card_id === pay.card_id);
  assert.equal(payPv.ok, true);
  assert.match(payPv.new, /六十日/, "预览按所选一级");
  const red = await tk.inv("riskcards.redline", { matter_id: m, document_version_id: s.doc.document_version_id });
  assert.equal(red.status, "applied", JSON.stringify(red));
  const text = extractParagraphs(Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: red.artifact_version_id })).data_base64, "base64")).map((p) => p.text).join("\n");
  assert.match(text, /验收合格后六十日内/);
  assert.doesNotMatch(text, /三十日内|七十五日/, "首选与底线都不写入");
  const manifest = JSON.parse(tk.kernel.db.get<{ manifest: string }>(`SELECT manifest FROM artifact_versions WHERE artifact_version_id = ?`, [red.artifact_version_id])!.manifest);
  assert.equal(manifest.lawyer_decisions.find((x: any) => x.card_id === pay.card_id).chosen_level, "fallback", "修订稿记录律师选的是哪一级");
  // 撤回决定后再“接受”：回到首选
  await tk.inv("riskcards.decide", { matter_id: m, card_id: pay.card_id, decision: "reset" });
  const back = await tk.inv("riskcards.decide", { matter_id: m, card_id: pay.card_id, decision: "accept" });
  assert.equal(back.card.chosen_level, "suggestion");
});

test("缺失条款写进修订稿（段后插入）；没给插入位置的只进意见表；对外版无批注、内部版带规则与类型；意见表一行一卡", { timeout: 60_000 }, async () => {
  const s = await setup("缺失与两版");
  submitRiskCards(s.deps, s.scope, {
    document_version_id: s.doc.document_version_id,
    cards: [
      { kind: "missing", insert_after: "双方对本合同内容负有保密义务。", searched_terms: ["保密期限"], severity: "mid", issue: "未约定保密期限", suggestion: "12.2 本条保密义务在本合同终止后五年内继续有效。" },
      { kind: "missing", searched_terms: ["不可抗力"], severity: "low", issue: "未约定不可抗力", suggestion: "不可抗力条款（略）" },
      { kind: "deviation", rule_ref: "R-3 管辖须在我方所在地", anchor_text: "争议提交卖方所在地人民法院诉讼解决。", severity: "mid", issue: "管辖偏离", suggestion: "争议提交买方所在地人民法院诉讼解决。" },
    ],
  });
  const m = s.matter.matter_id;
  const cards = (await tk.inv("riskcards.list", { matter_id: m, document_version_id: s.doc.document_version_id })).cards as any[];
  for (const c of cards) await tk.inv("riskcards.decide", { matter_id: m, card_id: c.card_id, decision: "accept" });
  const fm = cards.find((c) => c.issue === "未约定不可抗力");
  const pv = await tk.inv("riskcards.preview_redline", { matter_id: m, document_version_id: s.doc.document_version_id });
  assert.deepEqual(pv.cards.find((c: any) => c.card_id === fm.card_id), { card_id: fm.card_id, ok: false, reason: "no_insert_point" });
  const ins = pv.cards.find((c: any) => c.insert);
  assert.equal(ins.new, "12.2 本条保密义务在本合同终止后五年内继续有效。");

  const ext = await tk.inv("riskcards.redline", { matter_id: m, document_version_id: s.doc.document_version_id, audience: "external" });
  assert.equal(ext.status, "applied", JSON.stringify(ext));
  assert.deepEqual(ext.no_insert_point, [fm.card_id]);
  assert.match(ext.filename, /对外版/);
  const extBuf = Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: ext.artifact_version_id })).data_base64, "base64");
  const paras = extractParagraphs(extBuf).map((p) => p.text);
  const at = paras.indexOf("12.1 双方对本合同内容负有保密义务。");
  assert.equal(paras[at + 1], "12.2 本条保密义务在本合同终止后五年内继续有效。", "缺失条款插在 12.1 之后");
  assert.ok(paras.includes("15.1 争议提交买方所在地人民法院诉讼解决。"));
  const extComments = readZipText(extBuf, "word/comments.xml");
  assert.ok(!extComments || !/<w:comment\b/.test(extComments), "对外版不带批注");
  assert.doesNotMatch(readZipText(extBuf, "word/document.xml") ?? "", /commentReference/);

  const int = await tk.inv("riskcards.redline", { matter_id: m, document_version_id: s.doc.document_version_id, audience: "internal" });
  const intBuf = Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: int.artifact_version_id })).data_base64, "base64");
  const intComments = readZipText(intBuf, "word/comments.xml") ?? "";
  assert.match(intComments, /【缺失】/);
  assert.match(intComments, /【偏离规则】[\s\S]*规则：R-3 管辖须在我方所在地/);
  assert.match(int.filename, /内部版/);

  // 意见表：一行一卡（含没进修订稿的缺失卡），缺失核查列写清查过的说法
  const t = await tk.inv("riskcards.export_table", { matter_id: m, document_version_id: s.doc.document_version_id });
  assert.equal(t.rows, 3);
  assert.match(t.filename, /采购合同（审查意见表）\.xlsx/);
  const sheet = readZipText(Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: t.artifact_version_id })).data_base64, "base64"), "xl/worksheets/sheet1.xml") ?? "";
  for (const want of ["缺失", "偏离规则", "本所或客户规则", "查过：不可抗力", "R-3 管辖须在我方所在地", "接受"]) assert.ok(sheet.includes(want), `意见表含“${want}”`);
  assert.equal(findTokens(sheet).length, 0);
  const art = tk.kernel.db.get<{ kind: string; status: string }>(`SELECT kind, status FROM artifact_versions WHERE artifact_version_id = ?`, [t.artifact_version_id])!;
  assert.deepEqual(art, { kind: "review_table", status: "draft" });
});

test("同一段之后插两处：两条都写入、按卡的先后排；同一段里一插一改都写入；补充条款含后面某张卡的锚点也能生成（复核 Q2-04 / Q2-06）", { timeout: 60_000 }, async () => {
  const s = await setup("同处插入");
  submitRiskCards(s.deps, s.scope, {
    document_version_id: s.doc.document_version_id,
    cards: [
      { kind: "missing", insert_after: "双方对本合同内容", searched_terms: ["保密期限"], severity: "mid", issue: "甲", suggestion: "12.2 保密期限五年。" },
      // 改写排在插入之前提交：合并写入时仍须先插后改，否则插入位置的原文已被改掉
      { anchor_text: "负有保密义务", severity: "high", issue: "丙", suggestion: "负有保密及不竞争义务" },
      { kind: "missing", insert_after: "负有保密义务。", searched_terms: ["保密范围"], severity: "mid", issue: "乙", suggestion: "12.3 争议提交卖方所在地人民法院诉讼解决。" },
      { anchor_text: "争议提交卖方所在地人民法院诉讼解决。", severity: "mid", issue: "丁", suggestion: "争议提交买方所在地人民法院诉讼解决。" },
    ],
  });
  const m = s.matter.matter_id;
  for (const c of (await tk.inv("riskcards.list", { matter_id: m })).cards) await tk.inv("riskcards.decide", { matter_id: m, card_id: c.card_id, decision: "accept" });
  const r = await tk.inv("riskcards.redline", { matter_id: m, document_version_id: s.doc.document_version_id });
  assert.equal(r.status, "applied", JSON.stringify(r));
  const buf = Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: r.artifact_version_id })).data_base64, "base64");
  const paras = extractParagraphs(buf).map((p) => p.text);
  const at = paras.indexOf("12.1 双方对本合同内容负有保密及不竞争义务。");
  assert.ok(at >= 0, paras.join(" / "));
  assert.deepEqual(paras.slice(at + 1, at + 3), ["12.2 保密期限五年。", "12.3 争议提交卖方所在地人民法院诉讼解决。"], "按卡的先后接在一起");
  assert.ok(paras.includes("15.1 争议提交买方所在地人民法院诉讼解决。"), "原文那一处照常改；插入的条款不算多出来的匹配");
  assert.doesNotMatch(readZipText(buf, "word/document.xml") ?? "", /kwl-(anchor|ins)/, "临时标记不留在文件里");
});

test("复核 Q2-07 / Q2-08 / Q2-21：没写插入位置的缺失卡不算“引文找不到”；插不进去的缺失卡不计入“写进修订稿”的项数、预览分原因；只有可退让且选了的卡对 Agent 不是“知悉”；缺失卡重新提交时合并说法并重新复查", { timeout: 60_000 }, async () => {
  const s = await setup("Q2 一般项");
  const m = s.matter.matter_id;
  const r = submitRiskCards(s.deps, s.scope, {
    document_version_id: s.doc.document_version_id,
    cards: [
      { kind: "missing", searched_terms: ["不可抗力"], severity: "low", issue: "无插入位置", suggestion: "不可抗力条款。" },
      { kind: "missing", insert_after: "保密", searched_terms: ["保密期限"], severity: "low", issue: "插入位置多处", suggestion: "保密期限五年。" },
      { anchor_text: "争议提交卖方所在地人民法院诉讼解决。", severity: "low", issue: "只有可退让", fallback: "争议提交被告所在地人民法院诉讼解决。" },
    ],
  });
  assert.doesNotMatch(r.note, /引文在文档中找不到/, JSON.stringify(r.note));
  assert.match(r.note, /1 张出现多处/, "插入位置出现多处的照常提示");
  const cards = (await tk.inv("riskcards.list", { matter_id: m })).cards as any[];
  for (const c of cards) await tk.inv("riskcards.decide", { matter_id: m, card_id: c.card_id, decision: "accept", ...(c.issue === "只有可退让" ? { level: "fallback" } : {}) });
  const prog = (await tk.inv("riskcards.list", { matter_id: m, document_version_id: s.doc.document_version_id })).progress;
  assert.equal(prog.accepted, 1, "两张插不进去的缺失卡不算会写进修订稿");
  const pv = await tk.inv("riskcards.preview_redline", { matter_id: m, document_version_id: s.doc.document_version_id });
  const reason = (issue: string) => pv.cards.find((x: any) => x.card_id === cards.find((c) => c.issue === issue).card_id)?.reason;
  assert.equal(reason("无插入位置"), "no_insert_point");
  assert.equal(reason("插入位置多处"), "insert_point_ambiguous");
  // Agent 读到的状态与“是否改动合同”一致
  const { riskcardsList } = await import("../src/tools/tools/review.ts");
  const agentView = riskcardsList({ claims: { mid: m, tid: s.scope.tenantId, rid: s.scope.runId }, db: tk.kernel.db, blobs: tk.kernel.blobs } as any, {});
  const fb = agentView.cards.find((c: any) => c.issue === "只有可退让");
  assert.equal(fb!.lawyer_status, "accepted");
  assert.equal(fb!.changes_document, true);
  // 缺失卡重新提交：合并说法并重新复查（补充协议一里有“知识产权”）
  submitRiskCards(s.deps, s.scope, { document_version_id: s.doc.document_version_id, cards: [{ kind: "missing", searched_terms: ["著作权"], severity: "mid", issue: "知识产权归属", suggestion: "成果归买方。" }] });
  const again = submitRiskCards(s.deps, s.scope, { document_version_id: s.doc.document_version_id, cards: [{ kind: "missing", searched_terms: ["知识产权"], severity: "mid", issue: "知识产权归属", suggestion: "成果归买方。" }] });
  assert.ok(again.cards[0]!.duplicate_of);
  const ip = (await tk.inv("riskcards.list", { matter_id: m })).cards.find((c: any) => c.issue === "知识产权归属");
  assert.deepEqual(ip.searched_terms, ["著作权", "知识产权"]);
  assert.deepEqual(ip.searched_found.map((f: any) => f.term), ["知识产权"], "重新复查");
});

test("v9.4 第 20 批 C-02 残余：批量接受只收提示级与前后不一致类（重大、必须改、缺失、需客户决定不收）、撤回本批；误报驳回并记住说法（须在材料里出现）后同组缺失卡复查一起找；意见表 Word 版", { timeout: 60_000 }, async () => {
  const s = await setup("批量与误报");
  submitRiskCards(s.deps, s.scope, {
    document_version_id: s.doc.document_version_id,
    cards: [
      { kind: "consistency", rule_source: "general", anchor_text: "按日万分之五支付违约金", severity: "mid", issue: "比例口径不一", suggestion: "按日万分之三支付违约金" },
      { anchor_text: "逾期付款的", severity: "low", issue: "措辞", suggestion: "逾期支付的" },
      { anchor_text: "买方应于验收合格后九十日内支付货款。", severity: "high", issue: "付款期限", suggestion: "三十日内" },
      { anchor_text: "争议提交卖方所在地人民法院诉讼解决。", severity: "low", issue: "管辖", suggestion: "买方所在地", needs_client_decision: true },
      { kind: "missing", searched_terms: ["成果归属", "工作成果"], severity: "low", issue: "未约定成果归属", suggestion: "工作成果归买方所有。" },
      { anchor_text: "双方对本合同内容负有保密义务。", severity: "low", nature: "must", issue: "保密范围", suggestion: "双方对本合同内容及履行中知悉的商业秘密负有保密义务。" },
      { anchor_text: "验收合格后", severity: "mid", nature: "negotiable", issue: "一般风险", suggestion: "到货后" },
    ],
  });
  const m = s.matter.matter_id;
  const cards = (await tk.inv("riskcards.list", { matter_id: m })).cards as any[];
  const id = (issue: string) => cards.find((c) => c.issue === issue).card_id;
  const all = cards.map((c) => c.card_id);
  const r = await tk.inv("riskcards.decide_batch", { matter_id: m, card_ids: all, action: "accept" });
  assert.deepEqual(new Set(r.accepted), new Set([id("比例口径不一"), id("措辞")]));
  assert.equal(r.refused.length, 5, "一般级的普通风险卡也不进批量");
  assert.ok(r.batch.startsWith("cbt_"));
  let after = (await tk.inv("riskcards.list", { matter_id: m })).cards as any[];
  assert.equal(after.filter((c) => c.status === "accepted").length, 2);
  // 批量接受后又单独处理过的卡（复核 Q3-09）：不随本批撤回；不带批次号、批次号不对的撤不了
  await tk.inv("riskcards.decide", { matter_id: m, card_id: id("措辞"), decision: "reset" });
  await tk.inv("riskcards.decide", { matter_id: m, card_id: id("措辞"), decision: "accept" });
  await assert.rejects(tk.inv("riskcards.decide_batch", { matter_id: m, card_ids: r.accepted, action: "undo" }), /批次号/);
  assert.equal((await tk.inv("riskcards.decide_batch", { matter_id: m, card_ids: r.accepted, action: "undo", batch: "cbt_other" })).undone.length, 0);
  const u = await tk.inv("riskcards.decide_batch", { matter_id: m, card_ids: r.accepted, action: "undo", batch: r.batch });
  assert.deepEqual(u.undone, [id("比例口径不一")], "只撤本批里仍是批量接受的那张");
  after = (await tk.inv("riskcards.list", { matter_id: m })).cards as any[];
  assert.deepEqual(after.filter((c) => c.status === "accepted").map((c) => c.card_id), [id("措辞")], "单独接受的那张留下");

  // 误报：材料里写的是“知识产权归买方所有”——说法须在材料里出现过
  const miss = id("未约定成果归属");
  await assert.rejects(tk.inv("riskcards.reject_missing", { matter_id: m, card_id: id("措辞"), term: "x" }), /只有缺失类/);
  await assert.rejects(tk.inv("riskcards.reject_missing", { matter_id: m, card_id: miss, term: "成果权属约定" }), /没找到/);
  const rj = await tk.inv("riskcards.reject_missing", { matter_id: m, card_id: miss, term: "知识产权归买方" });
  assert.equal(rj.card.status, "rejected");
  assert.equal(rj.remembered, "知识产权归买方");
  // 以后同组（“工作成果”）的缺失卡：复查连补的说法一起找，标可能误报
  const again = submitRiskCards(s.deps, s.scope, { document_version_id: s.doc.document_version_id, cards: [{ kind: "missing", searched_terms: ["工作成果归属"], severity: "low", issue: "成果归属（另一次）", suggestion: "成果归买方。" }] });
  assert.equal(again.cards[0]!.searched_found, undefined, "说法组不相交：不扩展");
  const again2 = submitRiskCards(s.deps, s.scope, { document_version_id: s.doc.document_version_id, cards: [{ kind: "missing", searched_terms: ["工作成果", "成果所有权"], severity: "low", issue: "成果归属（第三次）", suggestion: "成果归买方。" }] });
  assert.ok(again2.cards[0]!.searched_found?.includes("知识产权归买方"), "同组：律师补的说法一起找");
  // 不记说法文字的审计
  assert.ok(!JSON.stringify(tk.kernel.db.all(`SELECT * FROM audit_events WHERE action = 'riskcard.decided'`, [])).includes("知识产权归买方"));

  // 意见表 Word 版
  const w = await tk.inv("riskcards.export_table", { matter_id: m, document_version_id: s.doc.document_version_id, format: "docx" });
  assert.match(w.filename, /（审查意见表）\.docx$/);
  const art = tk.kernel.db.get<{ storage_uri: string; kind: string }>(`SELECT storage_uri, kind FROM artifact_versions WHERE artifact_version_id = ?`, [w.artifact_version_id])!;
  assert.equal(art.kind, "review_table_docx");
  const xml = readZipText(tk.kernel.blobs.read(art.storage_uri), "word/document.xml")!;
  assert.ok(xml.includes("合同审查意见表") && xml.includes("判断依据") && xml.includes("付款期限"));
  const x = await tk.inv("riskcards.export_table", { matter_id: m, document_version_id: s.doc.document_version_id });
  assert.match(x.filename, /\.xlsx$/, "缺省仍是 Excel");
});

test("对方改动模式（C1 §2.2 第 7 条）：按回稿审查任务的基线比对，每处改动给出我方原稿与对方改稿，锚点在改动段的卡挂上；没有基线不可用", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "回稿", stance: "买方", consent_status: "agreed" });
  const m = matter.matter_id;
  const ours = await importBytes(tk.inv, m, "采购合同（我方稿）.docx", createDocx("采购合同", [{ heading: "第八条", paragraphs: ["8.1 买方应于验收合格后三十日内支付货款。", "8.2 逾期付款的，按日万分之三支付违约金。"] }]), DOCX);
  const theirs = await importBytes(tk.inv, m, "采购合同（对方回稿）.docx", createDocx("采购合同", [{ heading: "第八条", paragraphs: ["8.1 买方应于验收合格后九十日内支付货款。", "8.2 逾期付款的，按日万分之三支付违约金。"] }]), DOCX);
  const live = liveTaskIdentity(tk, m, "redraft");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "回稿", skill: "redraft-review", skill_args: { baseline: ours.document_version_id, current: theirs.document_version_id }, document_version_ids: [ours.document_version_id, theirs.document_version_id] }), live.rid]);
  submitRiskCards({ db: tk.kernel.db, blobs: tk.kernel.blobs }, { tenantId: live.tid, matterId: m, runId: live.rid }, {
    document_version_id: theirs.document_version_id,
    cards: [
      { anchor_text: "买方应于验收合格后九十日内支付货款。", severity: "high", issue: "【未采纳我方修改】付款期限改回九十日", suggestion: "买方应于验收合格后三十日内支付货款。" },
      { anchor_text: "按日万分之三支付违约金", severity: "low", issue: "未改动段落的卡" },
    ],
  });
  const none = await tk.inv("riskcards.counter_changes", { matter_id: m, document_version_id: theirs.document_version_id });
  assert.equal(none.available, false, "没有基线");
  const r = await tk.inv("riskcards.counter_changes", { matter_id: m, document_version_id: theirs.document_version_id, run_id: live.rid });
  assert.equal(r.available, true);
  assert.equal(r.baseline_filename, "采购合同（我方稿）.docx");
  assert.equal(r.stats.modified, 1);
  const ch = r.changes.find((c: any) => c.type === "modified");
  assert.match(ch.base_text, /三十日/);
  assert.match(ch.cur_text, /九十日/);
  assert.equal(ch.silent, true, "没有修订痕迹的改动是静默改动");
  const cards = (await tk.inv("riskcards.list", { matter_id: m })).cards as any[];
  assert.deepEqual(ch.card_ids, [cards.find((c) => c.issue.startsWith("【未采纳")).card_id]);
  // 律师指定基线也可以；基线与当前同一份不可用
  assert.equal((await tk.inv("riskcards.counter_changes", { matter_id: m, document_version_id: theirs.document_version_id, baseline_document_version_id: ours.document_version_id })).available, true);
  assert.equal((await tk.inv("riskcards.counter_changes", { matter_id: m, document_version_id: theirs.document_version_id, baseline_document_version_id: theirs.document_version_id })).available, false);
});
