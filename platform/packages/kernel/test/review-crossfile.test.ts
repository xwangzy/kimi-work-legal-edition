/**
 * v9.4 第 21 批 C-02 残余（评审 C1 §2 第 7、8 项）：
 * - 跨文件审查：风险卡附同一事项另一份文件（补充协议、附件）的逐字原文（related），内核在那份文件里定位；不能指向本卡所在文件、不能跨事项；
 * - 表格里的条款：锚点在 Word 表格单元格里时，卡片给出“表 n 第 r 行第 c 列（列名）”，接受后修订写进那一格。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, createStyledDocx, extractParagraphs, paragraphCells, readZipText } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { submitRiskCards } from "../src/services/review-cards.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "review-crossfile-firm");
});
after(async () => {
  await tk.kernel.close();
});

const priceTable = () =>
  createStyledDocx([
    { kind: "title", text: "采购合同" },
    { kind: "p", runs: [{ text: "第三条 价格见下表。" }] },
    {
      kind: "table",
      rows: [
        [[{ text: "货物" }], [{ text: "单价" }], [{ text: "付款节点" }]],
        [[{ text: "服务器" }], [{ text: "每台人民币 5 万元" }], [{ text: "验收后九十日" }]],
        [[{ text: "交换机" }], [{ text: "每台人民币 1 万元" }], [{ text: "验收后九十日内付清" }]],
      ],
    },
    { kind: "p", runs: [{ text: "第八条 买方应于验收合格后九十日内支付货款。" }] },
  ]);

test("paragraphCells：表格外为 null，表内按表 / 行 / 列编号，首行文字作列名", () => {
  const xml = readZipText(priceTable(), "word/document.xml")!;
  const cells = paragraphCells(xml);
  const paras = extractParagraphs(priceTable());
  assert.equal(cells.length, paras.length);
  const at = (t: string) => cells[paras.findIndex((p) => p.text === t)];
  assert.equal(at("第三条 价格见下表。"), null);
  assert.deepEqual(at("每台人民币 1 万元"), { table: 1, row: 3, col: 2, header: "单价" });
  assert.deepEqual(at("付款节点"), { table: 1, row: 1, col: 3, header: "付款节点" });
  assert.equal(at("第八条 买方应于验收合格后九十日内支付货款。"), null);
});

test("跨文件审查与表格单元格锚点：related 定位、校验；工作台给出单元格位置；接受后修订写进单元格", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "跨文件", stance: "买方", consent_status: "agreed" });
  const m = matter.matter_id;
  const main = await importBytes(tk.inv, m, "采购合同.docx", priceTable(), DOCX);
  const sup = await importBytes(tk.inv, m, "补充协议.docx", createDocx("补充协议", [{ heading: "第一条", paragraphs: ["1.1 原合同第八条的付款期限变更为验收合格后一百二十日内。"] }]), DOCX);
  const { matter: other } = await tk.inv("matters.create", { title: "别的事项", stance: "买方", consent_status: "agreed" });
  const foreign = await importBytes(tk.inv, other.matter_id, "别的合同.docx", createDocx("别的合同", [{ heading: "一", paragraphs: ["无关条款。"] }]), DOCX);
  const live = liveTaskIdentity(tk, m, "xfile");
  const scope = { tenantId: live.tid, matterId: m, runId: live.rid };
  const deps = { db: tk.kernel.db, blobs: tk.kernel.blobs };
  const base = { severity: "mid", category: "commercial", issue: "【权利义务】付款期限" };

  // 校验：不能指向本卡所在文件；不能跨事项；至多 5 段
  assert.throws(() => submitRiskCards(deps, scope, { document_version_id: main.document_version_id, cards: [{ ...base, anchor_text: "买方应于验收合格后九十日内支付货款。", related: [{ document_version_id: main.document_version_id, quote: "第三条 价格见下表。" }] }] }), /本卡所在的文件/);
  assert.throws(() => submitRiskCards(deps, scope, { document_version_id: main.document_version_id, cards: [{ ...base, anchor_text: "买方应于验收合格后九十日内支付货款。", related: [{ document_version_id: foreign.document_version_id, quote: "无关条款。" }] }] }), (e: any) => e.code === "not_found");
  assert.throws(() => submitRiskCards(deps, scope, { document_version_id: main.document_version_id, cards: [{ ...base, anchor_text: "买方应于验收合格后九十日内支付货款。", related: Array.from({ length: 6 }, () => ({ document_version_id: sup.document_version_id, quote: "x" })) }] }), /至多 5 段/);

  const r = submitRiskCards(deps, scope, {
    document_version_id: main.document_version_id,
    cards: [
      { ...base, anchor_text: "买方应于验收合格后九十日内支付货款。", issue: "【一致性】付款期限已被补充协议变更", related: [{ document_version_id: sup.document_version_id, quote: "原合同第八条的付款期限变更为验收合格后一百二十日内。", relation: "amends" }, { document_version_id: sup.document_version_id, quote: "补充协议里没有这句话" }] },
      { ...base, anchor_text: "验收后九十日内付清", suggestion: "验收后六十日内付清", issue: "【权利义务】交换机付款节点" },
    ],
  });
  assert.equal(r.submitted, 2);
  assert.match(r.note, /1 处引用的另一份文件原文在那份文件里找不到/);
  const list = (await tk.inv("riskcards.list", { matter_id: m, document_version_id: main.document_version_id })).cards as any[];
  const a = list.find((c) => c.issue.includes("补充协议"));
  assert.equal(a.related.length, 2);
  assert.deepEqual(
    a.related.map((x: any) => [x.filename, x.relation, x.anchor_status]),
    [["补充协议.docx", "amends", "located"], ["补充协议.docx", "refers", "not_found"]],
  );
  assert.equal(a.cell, undefined, "正文段落不在表格里");
  const b = list.find((c) => c.issue.includes("交换机"));
  assert.equal(b.cell, "表 1 第 3 行第 3 列（付款节点）");

  // 接受表格里的那张卡：修订写进那一格
  await tk.inv("riskcards.decide", { matter_id: m, card_id: b.card_id, decision: "accept" });
  const red = await tk.inv("riskcards.redline", { matter_id: m, document_version_id: main.document_version_id });
  assert.equal(red.status, "applied", JSON.stringify(red));
  const buf = Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: red.artifact_version_id })).data_base64, "base64");
  const xml = readZipText(buf, "word/document.xml")!;
  const tc = [...xml.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((x) => x[0]).find((x) => x.includes("<w:ins"));
  assert.ok(tc, "修订在表格单元格里");
  assert.match(tc!, /六十日/);
  assert.match(extractParagraphs(buf).map((p) => p.text).join("\n"), /验收后六十日内付清/);
});
