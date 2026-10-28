/**
 * 结构化补丁与令牌化工作区（v9 第 02 篇 §8.4；第 04 篇 §11 P6 的本机部分）：
 * - 100 份合成合同的修订任务：Agent 看到的是令牌形态，补丁的锚点与新文本也是令牌形态；内核还原代号后在原件副本上生成原生修订——
 *   成功率与交付件还原（零错名、零残留代号）；
 * - 冲突（版本已被取代、锚点不存在、多处命中无提示、未知代号、hash 不符、补丁重叠、非 DOCX）一律整体转预览，不写任何成果。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDocx, extractParagraphs, readZipEntries, writeZip } from "@zr-legal/docx-engine";
import { makeKernel, importBytes, importText, type TestKernel } from "./helpers.ts";
import { MatterTokenStore } from "../src/egress/matter-tokens.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SURNAMES = ["王", "李", "张", "刘", "陈", "杨", "赵", "黄", "周", "吴", "徐", "孙", "胡", "朱", "高", "林", "何", "郭", "马", "罗"];
const GIVEN = ["伟", "芳", "娜", "敏", "静", "丽", "强", "磊", "军", "洋", "勇", "艳", "杰", "娟", "涛", "明", "超", "秀英", "霞", "平"];

let tk: TestKernel;
let tokens: MatterTokenStore;

before(async () => {
  tk = await makeKernel({}, "patch-firm");
  tokens = new MatterTokenStore(tk.kernel.db);
});

after(async () => {
  await tk.kernel.close();
});

/** 合成一份借款合同：出借人为自然人（姓名 + 手机），借款人为公司。 */
function contract(i: number): { name: string; phone: string; paragraphs: string[] } {
  const name = `${SURNAMES[i % SURNAMES.length]}${GIVEN[(i * 7) % GIVEN.length]}`;
  const phone = `139${String(10_000_000 + i * 7919).slice(0, 8)}`;
  return {
    name,
    phone,
    paragraphs: [
      `出借人：${name}，联系电话 ${phone}。`,
      `借款人：第${i}号贸易有限公司。`,
      `第一条 借款金额为人民币${10 + i}万元，借款期限十二个月。`,
      `第二条 ${name}应于本合同签订之日起三日内将借款汇入借款人账户。`,
      "第三条 借款年利率为百分之六，按季付息。",
      `第四条 借款人逾期还款的，应向${name}支付逾期利息。`,
    ],
  };
}

test("100 份合同的结构化补丁：令牌形态的锚点与新文本经令牌表还原，在原件副本上生成原生修订；成功率 ≥ 99%，交付件零错名、零残留代号；原件不变", { timeout: 300_000 }, async (t) => {
  let ok = 0;
  const failures: string[] = [];
  for (let i = 0; i < 100; i++) {
    const c = contract(i);
    const { matter } = await tk.inv("matters.create", { title: `合同 ${i}`, stance: "借款人", client_name: c.name, consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-01" } });
    const docx = createDocx(`借款合同 ${i}`, [{ heading: "正文", paragraphs: c.paragraphs }]);
    const doc = await importBytes(tk.inv, matter.matter_id, `借款合同${i}.docx`, docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    // Agent 看到的令牌形态（与 A1 材料快照同一令牌化器）
    const [seen2, seen4] = tokens.tokenizeAll(matter.matter_id, [c.paragraphs[3]!, c.paragraphs[5]!]).map((r) => r.text);
    assert.ok(!seen2!.includes(c.name), "Agent 视图里没有真实姓名");
    const anchor2 = seen2!.slice(seen2!.indexOf("〔"), seen2!.indexOf("三日内") + 3); // “〔自然人·…〕应于本合同签订之日起三日内”
    const tokenOf = anchor2.slice(0, anchor2.indexOf("〕") + 1);
    const anchor4 = "支付逾期利息";
    const patches = [
      { anchor: anchor2, expected_text_hash: sha(anchor2), proposed_text: `${tokenOf}应于本合同签订之日起五个工作日内`, comment: `付款期限延长，便于${tokenOf}安排资金` },
      { anchor: anchor4, expected_text_hash: sha(anchor4), proposed_text: "支付逾期利息及实现债权的合理费用" },
    ];
    assert.ok(seen4!.includes(anchor4));
    const r = await tk.inv("matters.parties.list", { matter_id: matter.matter_id });
    assert.ok(r.parties.length >= 1);
    const out = await tk.inv("documents.patch", { matter_id: matter.matter_id, document_version_id: doc.document_version_id, patches });
    if (out.status !== "applied") {
      failures.push(`${i}: ${JSON.stringify(out.conflicts ?? out.reason)}`);
      continue;
    }
    // 交付件：还原后的真实姓名出现在新增文本与批注里；无残留代号；删除的是原文
    const art = await tk.inv("artifacts.download", { artifact_version_id: out.artifact_version_id });
    const buf = Buffer.from(art.data_base64, "base64");
    const xml = readZipEntries(buf).get("word/document.xml")!.toString("utf8");
    const comments = readZipEntries(buf).get("word/comments.xml")?.toString("utf8") ?? "";
    const allText = `${xml}${comments}`;
    const wrongName = /〔(自然人|电话|证件号|账号)·/.test(allText);
    // 第 28 批起修订只标改动的字：姓名在相同的开头里照原样保留（已还原为真名），删“三”、插“五个工作”
    const visible = extractParagraphs(buf).map((p) => p.text).join("\n");
    const insOk = visible.includes(`${c.name}应于本合同签订之日起五个工作日内`) && /<w:ins\b[^>]*>(?:(?!<\/w:ins>)[\s\S])*五个工作/.test(xml) && comments.includes(`便于${c.name}安排资金`);
    const delOk = xml.includes(`<w:delText xml:space="preserve">三</w:delText>`);
    if (!wrongName && insOk && delOk && visible.includes("实现债权的合理费用")) ok += 1;
    else failures.push(`${i}: wrongName=${wrongName} ins=${insOk} del=${delOk}`);
    // 原件不变（原件区只读）
    const orig = await tk.inv("materials.get", { document_version_id: doc.document_version_id }).catch(() => null);
    if (orig?.sha256) assert.equal(orig.sha256, doc.sha256);
  }
  t.diagnostic(`结构化补丁成功 ${ok}/100（每份 2 条补丁，含令牌形态锚点与批注）`);
  assert.ok(ok >= 99, `成功 ${ok}/100；失败：${failures.slice(0, 5).join("；")}`);
});

test("冲突一律整体转预览、不写成果：hash 不符、未知代号、锚点不存在、多处命中无提示、补丁重叠、非 DOCX、版本已被取代", { timeout: 120_000 }, async () => {
  const c = contract(7);
  const { matter } = await tk.inv("matters.create", { title: "冲突", stance: "借款人", client_name: c.name, consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-01" } });
  const docx = createDocx("借款合同", [{ heading: "正文", paragraphs: [...c.paragraphs, "第五条 本合同一式两份。", "第六条 本合同一式两份。"] }]);
  const doc = await importBytes(tk.inv, matter.matter_id, "冲突合同.docx", docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const tokenOfName = tokens.tokenize(matter.matter_id, c.name).text;
  const count = () => tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM artifact_versions WHERE matter_id = ? AND kind = 'revision_draft'`, [matter.matter_id])!.n;
  const call = (patches: unknown[], dv = doc.document_version_id) => tk.inv("documents.patch", { matter_id: matter.matter_id, document_version_id: dv, patches });
  const good = { anchor: "按季付息", expected_text_hash: sha("按季付息"), proposed_text: "按月付息" };
  const cases: [string, unknown[], string][] = [
    ["hash 不符", [good, { anchor: "借款期限十二个月", expected_text_hash: sha("别的文本"), proposed_text: "借款期限六个月" }], "anchor_hash_mismatch"],
    ["未知代号", [good, { anchor: "按季付息", expected_text_hash: sha("按季付息"), proposed_text: "〔自然人·ZZZZZZ〕负责付息" }], "unknown_token"],
    // 锚点不在当前版本的令牌化视图里（审查 S4-16：补丁绑定到 Agent 看到的文档内容）
    ["锚点不存在", [{ anchor: "第九条 不存在的条款", expected_text_hash: sha("第九条 不存在的条款"), proposed_text: "x" }], "anchor_not_in_view"],
    ["多处命中无提示", [{ anchor: "本合同一式两份", expected_text_hash: sha("本合同一式两份"), proposed_text: "本合同一式四份" }], "anchor_ambiguous"],
    ["补丁重叠", [good, { anchor: "百分之六，按季付息", expected_text_hash: sha("百分之六，按季付息"), proposed_text: "百分之五，按月付息" }], "overlap"],
  ];
  for (const [label, patches, reason] of cases) {
    const before = count();
    const r = await call(patches);
    assert.equal(r.status, "preview", label);
    assert.ok(r.conflicts.some((x: any) => x.reason === reason), `${label}：${JSON.stringify(r.conflicts)}`);
    assert.equal(count(), before, `${label}：不写任何成果`);
    assert.ok(r.preview.every((x: any) => typeof x.anchor_restored === "string"), "预览给出还原后的文本");
  }
  // 多处命中给出条款提示即可定位
  const hinted = await call([{ anchor: "本合同一式两份", expected_text_hash: sha("本合同一式两份"), proposed_text: "本合同一式四份", paragraph_hint: "第六条" }]);
  assert.equal(hinted.status, "applied", JSON.stringify(hinted));
  // 令牌形态的锚点（含代号）可定位并还原
  const tokAnchor = `向${tokenOfName}支付逾期利息`;
  const t = await call([{ anchor: tokAnchor, expected_text_hash: sha(tokAnchor), proposed_text: `向${tokenOfName}支付逾期利息及违约金` }]);
  assert.equal(t.status, "applied", JSON.stringify(t));
  assert.equal(t.preview[0].proposed_restored, `向${c.name}支付逾期利息及违约金`);
  // 非 DOCX
  const txt = await importText(tk.inv, matter.matter_id, "笔录.txt", "第一条 示例。");
  const r2 = await call([good], txt.document_version_id);
  assert.equal(r2.status, "preview");
  assert.equal(r2.reason, "not_docx");
  // 版本已被取代：只在当前版本上改
  const row = tk.kernel.db.get<Record<string, unknown>>(`SELECT * FROM document_versions WHERE document_version_id = ?`, [doc.document_version_id])!;
  const cols = Object.keys(row);
  const newer = { ...row, document_version_id: `${doc.document_version_id}_v2`, supersedes: doc.document_version_id };
  tk.kernel.db.run(`INSERT INTO document_versions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((k) => (newer as Record<string, unknown>)[k]));
  const r3 = await call([good]);
  assert.equal(r3.status, "preview");
  assert.equal(r3.reason, "document_version_superseded");
});

/** 手工构造的 document.xml：姓名跨 run（不同格式）、表格单元格、既有修订（律师的插入与删除）、编号段落；页眉另有姓名（不在正文视图）。 */
function richDocx(template: number, name: string, phone: string): Buffer {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const r = (t: string, rpr = "") => `<w:r>${rpr}<w:t xml:space="preserve">${t}</w:t></w:r>`;
  const bold = "<w:rPr><w:b/></w:rPr>";
  const p = (inner: string, ppr = "") => `<w:p>${ppr}${inner}</w:p>`;
  const num = '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>';
  const [first, rest] = [name.slice(0, 1), name.slice(1)];
  const paras: string[] = [];
  paras.push(p(r("借款合同") ));
  // 姓名跨两个 run，第二个 run 加粗
  paras.push(p(r(`出借人：${first}`) + r(`${rest}，联系电话 ${phone}。`, bold)));
  if (template % 2 === 0) {
    // 表格
    paras.push(
      `<w:tbl><w:tr><w:tc>${p(r("借款金额"))}</w:tc><w:tc>${p(r(`人民币${10 + template}万元`))}</w:tc></w:tr>` +
        `<w:tr><w:tc>${p(r("还款期限"))}</w:tc><w:tc>${p(r("十二个月"))}</w:tc></w:tr></w:tbl>`,
    );
  } else {
    paras.push(p(r(`第一条 借款金额人民币${10 + template}万元，还款期限十二个月。`), num));
  }
  // 既有修订：律师先前的插入与删除
  paras.push(
    p(
      r("第二条 ") +
        `<w:ins w:id="901" w:author="律师" w:date="2026-10-01T00:00:00Z">${r("借款用途为经营周转，")}</w:ins>` +
        `<w:del w:id="902" w:author="律师" w:date="2026-10-01T00:00:00Z"><w:r><w:delText xml:space="preserve">不得挪用，</w:delText></w:r></w:del>` +
        r(`${first}${rest}应于本合同签订之日起三日内放款。`),
    ),
  );
  paras.push(p(r(`第三条 借款人逾期还款的，应向${name}支付逾期利息。`), num));
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${paras.join("")}<w:sectPr/></w:body></w:document>`;
  const base = createDocx("占位", [{ heading: "占位", paragraphs: ["占位"] }]);
  const files = readZipEntries(base);
  files.set("word/document.xml", Buffer.from(doc, "utf8"));
  files.set("word/header1.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W}>${p(r(`经办人：${name}`))}</w:hdr>`, "utf8"));
  return writeZip([...files.entries()].map(([n, data]) => ({ name: n, data })));
}

test("多模板语料（审查 S4-16）：姓名跨 run、表格单元格、既有修订、编号段落——5 个模板 × 6 份，成功率与还原单列报告；页眉里的文字不在正文视图（转预览）", { timeout: 300_000 }, async (t) => {
  let ok = 0;
  let total = 0;
  const failures: string[] = [];
  for (let template = 0; template < 5; template++) {
    for (let k = 0; k < 6; k++) {
      total += 1;
      const i = template * 6 + k;
      const c = contract(200 + i);
      const { matter } = await tk.inv("matters.create", { title: `多模板 ${i}`, stance: "借款人", client_name: c.name, consent_status: "agreed" });
      const doc = await importBytes(tk.inv, matter.matter_id, `多模板${i}.docx`, richDocx(template, c.name, c.phone), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      const tokenOf = tokens.tokenize(matter.matter_id, c.name).text;
      const a1 = `${tokenOf}应于本合同签订之日起三日内放款`;
      const a2 = template % 2 === 0 ? "十二个月" : "还款期限十二个月";
      const a3 = `应向${tokenOf}支付逾期利息`;
      const patches = [
        { anchor: a1, expected_text_hash: sha(a1), proposed_text: `${tokenOf}应于本合同签订之日起五个工作日内放款` },
        { anchor: a2, expected_text_hash: sha(a2), proposed_text: template % 2 === 0 ? "十八个月" : "还款期限十八个月" },
        { anchor: a3, expected_text_hash: sha(a3), proposed_text: `应向${tokenOf}支付逾期利息及违约金` },
      ];
      const out = await tk.inv("documents.patch", { matter_id: matter.matter_id, document_version_id: doc.document_version_id, patches });
      if (out.status !== "applied") {
        failures.push(`${i}: ${JSON.stringify(out.conflicts ?? out.reason).slice(0, 200)}`);
        continue;
      }
      const art = await tk.inv("artifacts.download", { artifact_version_id: out.artifact_version_id });
      const buf = Buffer.from(art.data_base64, "base64");
      const xml = readZipEntries(buf).get("word/document.xml")!.toString("utf8");
      const visible = extractParagraphs(buf).map((x) => x.text).join("\n");
      const good =
        !/〔(自然人|电话)·/.test(xml) &&
        visible.includes(`${c.name}应于本合同签订之日起五个工作日内放款`) &&
        visible.includes("十八个月") &&
        visible.includes(`应向${c.name}支付逾期利息及违约金`) &&
        xml.includes('w:author="律师"') &&
        xml.includes("借款用途为经营周转");
      if (good) ok += 1;
      else failures.push(`${i}: 还原或保真检查未通过`);
    }
  }
  t.diagnostic(`多模板语料结构化补丁成功 ${ok}/${total}（每份 3 条补丁：跨 run 姓名锚点、表格或编号段落、含既有修订段落）`);
  assert.ok(ok / total >= 0.99, `成功 ${ok}/${total}；失败：${failures.slice(0, 5).join("；")}`);
  // 页眉里的文字不在正文视图：补丁转预览（不改页眉、不写成果）
  const c = contract(999);
  const { matter } = await tk.inv("matters.create", { title: "页眉", stance: "借款人", client_name: c.name, consent_status: "agreed" });
  const doc = await importBytes(tk.inv, matter.matter_id, "页眉.docx", richDocx(0, c.name, c.phone), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const tokenOf = tokens.tokenize(matter.matter_id, c.name).text;
  const ah = `经办人：${tokenOf}`;
  const r = await tk.inv("documents.patch", { matter_id: matter.matter_id, document_version_id: doc.document_version_id, patches: [{ anchor: ah, expected_text_hash: sha(ah), proposed_text: "经办人：另一人" }] });
  assert.equal(r.status, "preview");
  assert.equal(r.conflicts[0].reason, "anchor_not_in_view");
});
