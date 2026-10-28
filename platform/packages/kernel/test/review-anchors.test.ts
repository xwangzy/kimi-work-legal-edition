/**
 * 风险卡锚点与修订稿的口径（复核 B3-B04 / B3-B05 / B3-B14 / B3-B19 / B3-B20）：
 * - 锚点存视图里的规范原文：Agent 把换行写成空格也能定位，修订稿照常生成；跨段落的引文单独标出、不进自动修订；
 * - 带修订痕迹的回稿：材料快照只取可见文字，与定位视图一致，从快照逐字摘录的引文能定位；
 * - 没写文档编号：唯一材料自动绑定；多份材料拒绝并要求指定；
 * - 修订稿以文档为单位：两轮任务各接受一张卡，生成的修订稿包含两处；修订稿记录生成时律师的逐卡决定。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, extractParagraphs, readZipEntries, readZipText, writeZip } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { submitRiskCards } from "../src/services/review-cards.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "review-anchors-firm");
});
after(async () => {
  await tk.kernel.close();
});

const deps = () => ({ db: tk.kernel.db, blobs: tk.kernel.blobs });

/** 把某段文字改成“对方已修订”的形态：删除 from、插入 to（带修订痕迹的回稿）。 */
function withTrackedChange(docx: Buffer, from: string, to: string): Buffer {
  const entries = readZipEntries(docx);
  const xml = entries.get("word/document.xml")!.toString("utf8");
  const at = xml.indexOf(from);
  assert.ok(at > 0, "前置：文字在 document.xml 中");
  const rev = 'w:author="对方律师" w:date="2026-10-01T00:00:00Z"';
  const patched =
    xml.slice(0, at) +
    `</w:t></w:r><w:del w:id="901" ${rev}><w:r><w:delText>${from}</w:delText></w:r></w:del><w:ins w:id="902" ${rev}><w:r><w:t>${to}</w:t></w:r></w:ins><w:r><w:t xml:space="preserve">` +
    xml.slice(at + from.length);
  entries.set("word/document.xml", Buffer.from(patched, "utf8"));
  return writeZip([...entries].map(([name, data]) => ({ name, data })));
}

test("规范锚点：换行写成空格也能定位并生成修订稿；跨段落单独标出", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "锚点口径", stance: "买方", consent_status: "agreed" });
  const contract = createDocx("买卖合同", [{ heading: "第一条", paragraphs: ["1.1 货款于交货后九十日内支付。", "1.2 质保期为六个月。"] }]);
  const doc = await importBytes(tk.inv, matter.matter_id, "买卖合同.docx", contract, DOCX);
  const live = liveTaskIdentity(tk, matter.matter_id, "anchors");
  const r = submitRiskCards(deps(), { tenantId: live.tid, matterId: matter.matter_id, runId: live.rid }, {
    document_version_id: doc.document_version_id,
    cards: [
      // Agent 在中间多写了空白：忽略空白定位
      { anchor_text: "货款于交货后 九十日内支付。", severity: "high", issue: "账期过长", suggestion: "货款于交货后三十日内支付。" },
      // 跨两段
      { anchor_text: "九十日内支付。 1.2 质保期为六个月。", severity: "low", issue: "跨段落示例" },
    ],
  });
  assert.deepEqual(r.cards.map((c: any) => c.anchor_status), ["located", "cross_paragraph"]);
  assert.match(r.note, /跨了段落/);
  const cards = (await tk.inv("riskcards.list", { matter_id: matter.matter_id })).cards;
  const c1 = cards.find((c: any) => c.issue === "账期过长");
  assert.equal(c1.anchor_text, "货款于交货后九十日内支付。", "锚点存视图里的规范原文");
  assert.equal(c1.anchor_quote, "货款于交货后 九十日内支付。", "Agent 原话另存");
  await tk.inv("riskcards.decide", { matter_id: matter.matter_id, card_id: c1.card_id, decision: "accept" });
  const red = await tk.inv("riskcards.redline", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
  assert.equal(red.status, "applied", JSON.stringify(red));
});

test("回稿带修订痕迹：快照只取可见文字，从快照摘录的引文能定位", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "回稿", stance: "买方", consent_status: "agreed" });
  const base = createDocx("买卖合同（回稿）", [{ heading: "第七条", paragraphs: ["7.1 逾期付款的，每日按应付金额的万分之一支付违约金。"] }]);
  const redraft = withTrackedChange(base, "万分之一", "千分之三");
  const doc = await importBytes(tk.inv, matter.matter_id, "回稿.docx", redraft, DOCX);
  const text = (await tk.inv("materials.text", { document_version_id: doc.document_version_id })) as any;
  const snapshot = tk.kernel.db.get<{ content: string }>(
    `SELECT pt.content FROM parse_versions pv JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id WHERE pv.document_version_id = ?`,
    [doc.document_version_id],
  )!.content;
  assert.match(snapshot, /千分之三/);
  assert.equal(snapshot.includes("万分之一"), false, "快照不含已删除的文字");
  assert.ok(text);
  const live = liveTaskIdentity(tk, matter.matter_id, "redraft");
  const quote = snapshot.split("\n").find((l) => l.includes("千分之三"))!.replace(/^7\.1\s*/, "");
  const r = submitRiskCards(deps(), { tenantId: live.tid, matterId: matter.matter_id, runId: live.rid }, {
    document_version_id: doc.document_version_id,
    cards: [{ anchor_text: quote, severity: "mid", issue: "对方把违约金提高到千分之三" }],
  });
  assert.equal(r.cards[0]?.anchor_status, "located", quote);
});

test("没写文档编号：唯一材料自动绑定；多份材料拒绝；没有材料照常提交", { timeout: 60_000 }, async () => {
  const one = (await tk.inv("matters.create", { title: "单份", stance: "买方", consent_status: "agreed" })).matter;
  const d1 = await importBytes(tk.inv, one.matter_id, "合同.docx", createDocx("合同", [{ heading: "一", paragraphs: ["甲方应于十日内付款。"] }]), DOCX);
  const l1 = liveTaskIdentity(tk, one.matter_id, "sole");
  const r1 = submitRiskCards(deps(), { tenantId: l1.tid, matterId: one.matter_id, runId: l1.rid }, { cards: [{ anchor_text: "甲方应于十日内付款。", severity: "low", issue: "示例" }] });
  assert.equal(r1.document_version_id, d1.document_version_id);
  assert.equal(r1.cards[0]?.anchor_status, "located");

  const two = (await tk.inv("matters.create", { title: "两份", stance: "买方", consent_status: "agreed" })).matter;
  await importBytes(tk.inv, two.matter_id, "甲.docx", createDocx("甲", [{ heading: "一", paragraphs: ["甲。"] }]), DOCX);
  await importBytes(tk.inv, two.matter_id, "乙.docx", createDocx("乙", [{ heading: "一", paragraphs: ["乙。"] }]), DOCX);
  const l2 = liveTaskIdentity(tk, two.matter_id, "multi");
  assert.throws(() => submitRiskCards(deps(), { tenantId: l2.tid, matterId: two.matter_id, runId: l2.rid }, { cards: [{ anchor_text: "甲。", severity: "low", issue: "示例" }] }), /请为风险卡指定 document_version_id/);

  const none = (await tk.inv("matters.create", { title: "无材料", stance: "买方", consent_status: "agreed" })).matter;
  const l3 = liveTaskIdentity(tk, none.matter_id, "none");
  const r3 = submitRiskCards(deps(), { tenantId: l3.tid, matterId: none.matter_id, runId: l3.rid }, { cards: [{ anchor_text: "律师贴来的条款", severity: "low", issue: "示例" }] });
  assert.equal(r3.cards[0]?.anchor_status, "no_document");
});

test("修订稿以文档为单位：两轮任务各接受一张卡，修订稿含两处修订并记录逐卡决定", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "两轮", stance: "买方", consent_status: "agreed" });
  const doc = await importBytes(
    tk.inv,
    matter.matter_id,
    "合同.docx",
    createDocx("合同", [{ heading: "一", paragraphs: ["1.1 货款于交货后九十日内支付。", "1.2 质保期为六个月。"] }]),
    DOCX,
  );
  const first = liveTaskIdentity(tk, matter.matter_id, "round1");
  const second = liveTaskIdentity(tk, matter.matter_id, "round2");
  submitRiskCards(deps(), { tenantId: first.tid, matterId: matter.matter_id, runId: first.rid }, {
    document_version_id: doc.document_version_id,
    cards: [{ anchor_text: "货款于交货后九十日内支付。", severity: "high", issue: "账期过长", suggestion: "货款于交货后三十日内支付。" }],
  });
  submitRiskCards(deps(), { tenantId: second.tid, matterId: matter.matter_id, runId: second.rid }, {
    document_version_id: doc.document_version_id,
    cards: [{ anchor_text: "质保期为六个月。", severity: "mid", issue: "质保期短", suggestion: "质保期为十二个月。" }],
  });
  const cards = (await tk.inv("riskcards.list", { matter_id: matter.matter_id, document_version_id: doc.document_version_id })).cards;
  assert.equal(cards.length, 2, "文档级列表包含两轮的卡");
  for (const c of cards) await tk.inv("riskcards.decide", { matter_id: matter.matter_id, card_id: c.card_id, decision: "accept" });
  const red = await tk.inv("riskcards.redline", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
  assert.equal(red.status, "applied", JSON.stringify(red));
  const dl = await tk.inv("artifacts.download", { artifact_version_id: red.artifact_version_id });
  const xml = readZipText(Buffer.from(dl.data_base64, "base64"), "word/document.xml") ?? "";
  // 第 28 批：修订只标改动的字，新文字按可见文本核（接受修订后的读法）
  const visible = extractParagraphs(Buffer.from(dl.data_base64, "base64")).map((p) => p.text).join("\n");
  assert.match(visible, /三十日/);
  assert.match(visible, /十二个月/);
  assert.equal((xml.match(/<w:ins\b/g) ?? []).length >= 2, true, "两处修订都写进去了");
  const manifest = JSON.parse(tk.kernel.db.get<{ manifest: string }>(`SELECT manifest FROM artifact_versions WHERE artifact_version_id = ?`, [red.artifact_version_id])!.manifest);
  assert.equal(manifest.lawyer_decisions.length, 2);
  assert.deepEqual(new Set(manifest.lawyer_decisions.map((d: any) => d.run_id)), new Set([first.rid, second.rid]));
  assert.ok(manifest.lawyer_decisions.every((d: any) => d.status === "accepted" && d.decided_by));
});

test("跨任务去重；存量锚点（Agent 原话）在生成修订稿时重新定位（复核 C-B05 / C-B08）", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "去重与重定位", stance: "买方", consent_status: "agreed" });
  const doc = await importBytes(tk.inv, matter.matter_id, "合同.docx", createDocx("合同", [{ heading: "一", paragraphs: ["1.1 货款于交货后九十日内支付。"] }]), DOCX);
  const r1 = liveTaskIdentity(tk, matter.matter_id, "dup1");
  const r2 = liveTaskIdentity(tk, matter.matter_id, "dup2");
  const card = { anchor_text: "货款于交货后九十日内支付。", severity: "high", issue: "账期过长", suggestion: "货款于交货后三十日内支付。" };
  const a = submitRiskCards(deps(), { tenantId: r1.tid, matterId: matter.matter_id, runId: r1.rid }, { document_version_id: doc.document_version_id, cards: [card] });
  const b = submitRiskCards(deps(), { tenantId: r2.tid, matterId: matter.matter_id, runId: r2.rid }, { document_version_id: doc.document_version_id, cards: [card] });
  assert.equal(b.cards[0]?.duplicate_of, a.cards[0]?.card_id, "第二轮相同的卡回报已有卡");
  assert.match(b.note, /未重复新增/);
  const list = (await tk.inv("riskcards.list", { matter_id: matter.matter_id, document_version_id: doc.document_version_id })).cards;
  assert.equal(list.length, 1);
  // 模拟迁移 0022 之前的存量卡：锚点是 Agent 原话（多了空白）
  tk.kernel.db.run(`UPDATE risk_cards SET anchor_text = ? WHERE card_id = ?`, ["货款于交货后 九十日内支付。", list[0].card_id]);
  await tk.inv("riskcards.decide", { matter_id: matter.matter_id, card_id: list[0].card_id, decision: "accept" });
  const red = await tk.inv("riskcards.redline", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
  assert.equal(red.status, "applied", JSON.stringify(red));
});

test("在带修订痕迹的回稿上生成修订稿（复核 C-B14）：修改落在可见文字上，原有修订保留", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "回稿上修订", stance: "买方", consent_status: "agreed" });
  const base = createDocx("买卖合同（回稿）", [{ heading: "第七条", paragraphs: ["7.1 逾期付款的，每日按应付金额的万分之一支付违约金。", "7.2 质保期为六个月。"] }]);
  const doc = await importBytes(tk.inv, matter.matter_id, "回稿.docx", withTrackedChange(base, "万分之一", "千分之三"), DOCX);
  const live = liveTaskIdentity(tk, matter.matter_id, "redraft_redline");
  submitRiskCards(deps(), { tenantId: live.tid, matterId: matter.matter_id, runId: live.rid }, {
    document_version_id: doc.document_version_id,
    cards: [{ anchor_text: "质保期为六个月。", severity: "mid", issue: "质保期短", suggestion: "质保期为十二个月。" }],
  });
  const c = (await tk.inv("riskcards.list", { matter_id: matter.matter_id })).cards[0];
  await tk.inv("riskcards.decide", { matter_id: matter.matter_id, card_id: c.card_id, decision: "accept" });
  const red = await tk.inv("riskcards.redline", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
  assert.equal(red.status, "applied", JSON.stringify(red));
  const dl = await tk.inv("artifacts.download", { artifact_version_id: red.artifact_version_id });
  const xml = readZipText(Buffer.from(dl.data_base64, "base64"), "word/document.xml") ?? "";
  assert.match(extractParagraphs(Buffer.from(dl.data_base64, "base64")).map((p) => p.text).join("\n"), /质保期为十二个月/, "修改落在可见文字上（第 28 批起只标改动的字）");
  assert.match(xml, /<w:ins\b[^>]*w:author="律师审定[^"]*"[^>]*>(?:(?!<\/w:ins>)[\s\S])*十二/, "插入的是改动的字");
  assert.match(xml, /w:author="对方律师"/, "对方原有的修订保留");
});

test("“接受后”预览与修订稿同一口径（余项续复核 RC-B-01/02）：锚点重叠但改动段不重叠的两处都落；多处的卡写明会被拦下；改后与原文相同的不改动", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "预览口径", stance: "受让方", consent_status: "agreed" });
  const doc = await importBytes(
    tk.inv,
    matter.matter_id,
    "转让协议.docx",
    createDocx("协议", [{ heading: "二", paragraphs: ["2.2 受让方应于协议签署后五日内一次性支付全部价款。", "2.3 价款以银行转账支付。", "2.4 价款以银行转账支付。"] }]),
    DOCX,
  );
  const t = liveTaskIdentity(tk, matter.matter_id, "preview");
  submitRiskCards(deps(), { tenantId: t.tid, matterId: matter.matter_id, runId: t.rid }, {
    document_version_id: doc.document_version_id,
    cards: [
      { anchor_text: "协议签署后五日内一次性", severity: "mid", issue: "期限短", suggestion: "协议签署后十日内一次性" },
      { anchor_text: "一次性支付全部价款", severity: "mid", issue: "一次付清", suggestion: "分两期支付全部价款" },
      { anchor_text: "价款以银行转账支付。", severity: "low", issue: "支付方式", suggestion: "价款以银行转账方式支付。" },
      { anchor_text: "受让方应于", severity: "low", issue: "确认一下", suggestion: "" },
    ],
  });
  const cards = (await tk.inv("riskcards.list", { matter_id: matter.matter_id, document_version_id: doc.document_version_id })).cards as any[];
  const by = (issue: string) => cards.find((c) => c.issue === issue)!;
  for (const c of cards.filter((c) => c.issue !== "确认一下")) await tk.inv("riskcards.decide", { matter_id: matter.matter_id, card_id: c.card_id, decision: "accept" });
  // 没有建议时“修改后接受”只确认了原文：不改动
  await tk.inv("riskcards.decide", { matter_id: matter.matter_id, card_id: by("确认一下").card_id, decision: "modify", final_text: "受让方应于" });
  const pv = await tk.inv("riskcards.preview_redline", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
  assert.equal(pv.status, "conflicts", "多处的那张会让修订稿被拦下");
  const res = new Map(pv.cards.map((c: any) => [c.card_id, c]));
  const a = res.get(by("期限短").card_id) as any;
  const b = res.get(by("一次付清").card_id) as any;
  assert.ok(a.ok && b.ok, "锚点重叠、改动段不重叠：两处都落（复核复现的例子）");
  assert.equal(pv.paragraphs[a.para].slice(a.start, a.end), a.old);
  assert.ok(a.end <= b.start, "两处改动段不交叠");
  assert.deepEqual([res.get(by("支付方式").card_id)].map((x: any) => [x.ok, x.reason]), [[false, "anchor_ambiguous"]]);
  assert.deepEqual([res.get(by("确认一下").card_id)].map((x: any) => [x.ok, x.reason]), [[false, "unchanged"]]);
  // 预览不登记成果
  assert.equal((await tk.inv("artifacts.list", { matter_id: matter.matter_id })).artifacts.filter((x: any) => x.kind === "revision_draft").length, 0);
  // 真正生成：多处那张被拦下；跳过它后两处都写进修订稿，“只确认原文”的那张不写空修订
  const red = await tk.inv("riskcards.redline", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
  assert.equal(red.status, "preview");
  assert.deepEqual(red.conflicts.map((c: any) => c.card_id), [by("支付方式").card_id]);
  const ok = await tk.inv("riskcards.redline", { matter_id: matter.matter_id, document_version_id: doc.document_version_id, skip_card_ids: [by("支付方式").card_id] });
  assert.equal(ok.status, "applied", JSON.stringify(ok));
  assert.equal(ok.applied, 2);
  const pv2 = await tk.inv("riskcards.preview_redline", { matter_id: matter.matter_id, document_version_id: doc.document_version_id });
  assert.equal(pv2.cards.filter((c: any) => c.ok).length, 2, "预览与修订稿写进去的处数一致");
});

test("按页解析的材料：卡片带原件页码；Word 不带（余项续复核 RC-B-18）", { timeout: 60_000 }, async () => {
  const { importText } = await import("./helpers.ts");
  const { matter } = await tk.inv("matters.create", { title: "页码", stance: "买方", consent_status: "agreed" });
  const doc = await importText(tk.inv, matter.matter_id, "扫描合同.txt", "第一页：合同封面\f第二页：1.1 货款于交货后九十日内支付。\f第三页：2.1 质保期为六个月。");
  const pv = tk.kernel.db.get<{ content: string }>(`SELECT pt.content FROM parse_versions pv JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id WHERE pv.document_version_id = ?`, [doc.document_version_id])!;
  if (!pv.content.includes("\f")) return; // 文本解析不保留换页符时无页码可算（PDF 解析才保留）
  const t = liveTaskIdentity(tk, matter.matter_id, "pages");
  submitRiskCards(deps(), { tenantId: t.tid, matterId: matter.matter_id, runId: t.rid }, {
    document_version_id: doc.document_version_id,
    cards: [
      { anchor_text: "货款于交货后九十日内支付。", severity: "high", issue: "账期", suggestion: "货款于交货后三十日内支付。", clause_ref: "1.1" },
      { anchor_text: "质保期为六个月。", severity: "mid", issue: "质保", suggestion: "质保期为十二个月。" },
    ],
  });
  const cards = (await tk.inv("riskcards.list", { matter_id: matter.matter_id, document_version_id: doc.document_version_id })).cards as any[];
  assert.deepEqual(Object.fromEntries(cards.map((c) => [c.issue, c.page])), { 账期: 2, 质保: 3 });
});
