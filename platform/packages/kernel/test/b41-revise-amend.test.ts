/**
 * V16 第 41 批真实走查（审合同并出建议修订稿，40 分钟内没交出修订稿）：
 * - 助手三次调用 docx.revise，每次都重发全部 61 条修改（约 1.3 万字，生成一次 2～3 分钟）：现在内核记住本任务对这份原件上一次提交的
 *   完整清单，更正时只交要换、要删、要加的几条（amend），内核合成完整清单后照原流程从原件重新生成；
 * - 同一批里先把付款表行名“尾款”改成“质保金”，后面按“尾款｜比例”定位同一行的格子对不上：提示一律按原件认；
 * - 付款表里“30%”写 occurrence=1 想指全文第二处，报“找不到”却没说表格格子该怎么定位：退回说明写明 occurrence 只数段内、格子用“行名｜列名”；
 * - 正式写入也返回每处改前 / 改后的整段，方法可以直接提交、读结果、补交更正，不必先试写再全量重交。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, extractParagraphs, readZipEntries, sanitizeDocx, writeZip } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { amendPatches } from "../src/tools/tools/revise.ts";
import { findTool } from "../src/tools/registry.ts";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b41-amend-firm");
});
after(async () => {
  await tk.kernel.close();
});

const wp = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const wtc = (text: string) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${wp(text)}</w:tc>`;
const wtr = (cells: string[]) => `<w:tr>${cells.map(wtc).join("")}</w:tr>`;

/** 设备采购合同的付款部分：3.1 定金条款、3.2 付款表（款项｜比例｜金额（元）｜支付时间）、3.3 尾款与发票。 */
function purchaseContract(): Buffer {
  const body = [
    wp("第三条 价款与支付"),
    wp("3.1 甲方应于本合同签订之日起5个工作日内向乙方支付定金人民币960,000元（合同价款的30%）。"),
    wp("3.2 合同价款按下表分期支付："),
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(4)}</w:tblGrid>${[
      wtr(["款项", "比例", "金额（元）", "支付时间"]),
      wtr(["定金", "30%", "960,000", "本合同签订之日起5个工作日内"]),
      wtr(["发货款", "40%", "1,280,000", "乙方发出发货通知之日起3日内"]),
      wtr(["验收款", "25%", "800,000", "验收合格之日起10日内"]),
      wtr(["尾款", "5%", "160,000", "验收合格满12个月之日起10日内"]),
    ].join("")}</w:tbl>`,
    wp("3.3 尾款作为质量保证，乙方收到每期款项之日起30日内开具发票。"),
    wp("第四条 交付"),
    wp("4.1 乙方应于收到发货款之日起60日内交货。"),
  ].join("");
  const files = readZipEntries(createDocx("设备采购合同", [{ heading: "占位", paragraphs: ["占位"] }]));
  files.set("word/document.xml", Buffer.from(files.get("word/document.xml")!.toString("utf8").replace(/<w:body>[\s\S]*?(<w:sectPr)/, `<w:body>${body}$1`)));
  return writeZip([...files.entries()].map(([name, data]) => ({ name, data })));
}

async function reviseAgent(matterId: string, label: string) {
  const { Agent, fetch } = await import("undici");
  const live = liveTaskIdentity(tk, matterId, label);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const raw = async (name: string, args: unknown) =>
    (await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }), dispatcher: agent }).then((x) => x.json())) as any;
  const call = async (name: string, args: unknown) => {
    const r = await raw(name, args);
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r).slice(0, 800)}`);
    return r.result.structuredContent;
  };
  /** 工具报错（入参不对）：返回错误文字。 */
  const fail = async (name: string, args: unknown) => {
    const r = await raw(name, args);
    assert.ok(r.error || r.result?.isError === true, `应当报错：${JSON.stringify(r).slice(0, 400)}`);
    return JSON.stringify(r);
  };
  return { live, call, fail, close: () => agent.close() };
}

const cleanText = async (id: string) => extractParagraphs(sanitizeDocx(Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: id })).data_base64, "base64")).docx).map((p) => p.text);
const rowOf = (paras: string[], name: string) => {
  const i = paras.indexOf(name);
  return i < 0 ? [] : paras.slice(i, i + 4);
};

/** 六条修改：第 2 条用 occurrence 数全文第二处（格子里只有一处），第 6 条锚点抄错——这两条定位不到；第 3 条先改行名、第 4、5 条按原行名定位同一行。 */
const SIX = [
  { anchor: "定金人民币960,000元（合同价款的30%）", proposed_text: "定金人民币320,000元（合同价款的10%）", comment: "意见5：定金降至10%" },
  { anchor: "30%", occurrence: 1, proposed_text: "10%", comment: "意见5：付款表定金比例同步" },
  { anchor: "尾款", paragraph_hint: "3.2｜尾款｜款项", proposed_text: "质保金", comment: "意见5：尾款明确为质保金" },
  { anchor: "5%", paragraph_hint: "尾款｜比例", proposed_text: "10%" },
  { anchor: "160,000", paragraph_hint: "尾款｜金额（元）", proposed_text: "320,000" },
  { anchor: "乙方在收到每期款项之日起30日内开具发票", proposed_text: "乙方应在每期付款条件成就前开具合规发票" },
];

test("补交合成（纯函数）：按序号换、删，末尾加；越界、重复、既换又删报错", () => {
  const prev = [{ anchor: "a", proposed_text: "1" }, { anchor: "b", proposed_text: "2" }, { anchor: "c", proposed_text: "3" }];
  const r = amendPatches(prev, { replace: [{ index: 2, patch: { anchor: "B", proposed_text: "22", junk: 1 } }], remove: [1], add: [{ anchor: "d", proposed_text: "4" }] });
  assert.deepEqual(r.patches, [{ anchor: "B", proposed_text: "22" }, { anchor: "c", proposed_text: "3" }, { anchor: "d", proposed_text: "4" }], "未知字段不进清单");
  assert.deepEqual(r.summary, { base: 3, replaced: 1, removed: 1, added: 1, total: 3 });
  assert.deepEqual(amendPatches(prev, {}).patches, prev, "空的 amend 即照上一次清单");
  assert.throws(() => amendPatches(prev, { remove: [4] }), /1～3 之间/);
  assert.throws(() => amendPatches(prev, { remove: [0] }), /1～3 之间/);
  assert.throws(() => amendPatches(prev, { replace: [{ index: 1, patch: { anchor: "x", proposed_text: "" } }, { index: 1, patch: { anchor: "y", proposed_text: "" } }] }), /出现了两次/);
  assert.throws(() => amendPatches(prev, { replace: [{ index: 1, patch: { anchor: "x", proposed_text: "" } }], remove: [1] }), /同时出现/);
});

test("docx.revise 入参：patches 不再必填，amend 的结构写在 schema 里，说明写清补交与直接提交", () => {
  const t = findTool("docx.revise")!;
  const schema = t.inputSchema as any;
  assert.deepEqual(schema.required, ["document_version_id"]);
  assert.deepEqual(Object.keys(schema.properties.amend.properties).sort(), ["add", "remove", "replace"]);
  assert.deepEqual(schema.properties.amend.properties.replace.items.required, ["index", "patch"]);
  assert.match(t.description, /amend/);
  assert.match(t.description, /直接正式提交/);
  assert.match(t.description, /行名｜列名/);
});

test("补交：六条里两条定位不到整批不写→只换这两条写入成功（六处都在、先改行名不影响同一行定位）→再删一条加一条出新版本；正式写入返回改后整段", { timeout: 180_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "设备采购合同修订 补交", stance: "买方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-10" } });
  const doc = await importBytes(tk.inv, matter.matter_id, "设备采购合同（乙方稿）.docx", purchaseContract(), DOCX_MIME);
  const a = await reviseAgent(matter.matter_id, "amend");
  try {
    const first = await a.call("docx.revise", { document_version_id: doc.document_version_id, patches: SIX });
    assert.equal(first.status, "not_applied", JSON.stringify(first).slice(0, 800));
    assert.deepEqual(first.conflicts.map((c: any) => c.index), [2, 6], "序号从 1 起");
    const occ = first.conflicts[0];
    assert.equal(occ.reason, "anchor_not_found");
    assert.match(occ.detail, /occurrence=1 要的是同一段落里的第 2 次出现/);
    assert.match(occ.fix, /行名｜列名/, "退回说明告诉助手表格格子用“行名｜列名”定位");
    assert.match(first.note, /amend\.replace/);
    assert.match(first.note, /不要把全部修改重发/);
    const revisions = () => tk.kernel.db.all<{ version: number }>(`SELECT version FROM artifact_versions WHERE run_id = ? AND kind = 'revision_draft' AND filename LIKE '%（修订稿）.docx' ORDER BY version`, [a.live.rid]);
    assert.equal(revisions().length, 0, "整批不写");

    // 只换这两条
    const second = await a.call("docx.revise", {
      document_version_id: doc.document_version_id,
      amend: {
        replace: [
          { index: 2, patch: { anchor: "30%", paragraph_hint: "定金｜比例", proposed_text: "10%", comment: "意见5：付款表定金比例同步" } },
          { index: 6, patch: { anchor: "乙方收到每期款项之日起30日内开具发票。", proposed_text: "乙方应在每期付款条件成就前开具合规发票。" } },
        ],
      },
    });
    assert.equal(second.status, "applied", JSON.stringify(second).slice(0, 1200));
    assert.equal(second.applied, 6);
    assert.deepEqual(second.amend, { base: 6, replaced: 2, removed: 0, added: 0, total: 6 });
    assert.match(second.amend_note, /本次在上一次 6 条的基础上替换 2 条、删除 0 条、新增 0 条，合计 6 条/);
    // 正式写入返回每处改前 / 改后的整段（与试写同样的字段）
    const flat = JSON.stringify(second.changes);
    assert.ok(second.changes.some((c: any) => c.before === "尾款" && c.after === "质保金"), flat);
    assert.ok(second.changes.some((c: any) => /定金人民币320,000元（合同价款的10%）/.test(c.after) && /960,000/.test(c.before)), flat);
    assert.match(second.note, /逐段读 changes/);
    assert.match(second.note, /amend/);
    let paras = await cleanText(second.clean.artifact_version_id);
    assert.deepEqual(rowOf(paras, "定金"), ["定金", "10%", "960,000", "本合同签订之日起5个工作日内"]);
    assert.deepEqual(rowOf(paras, "质保金"), ["质保金", "10%", "320,000", "验收合格满12个月之日起10日内"], "先改行名，同一行按原行名定位的两格照样改到");
    assert.deepEqual(rowOf(paras, "验收款"), ["验收款", "25%", "800,000", "验收合格之日起10日内"], "“25%”里的“5%”没被误改");
    assert.ok(paras.some((t) => t.includes("定金人民币320,000元（合同价款的10%）")));
    assert.ok(paras.includes("3.3 尾款作为质量保证，乙方应在每期付款条件成就前开具合规发票。"), JSON.stringify(paras));
    assert.equal(revisions().length, 1);

    // 再删一条（第 5 条：金额）、加一条（交货期）：在上一次（已写入的）清单上补交，生成新版本，旧版本保留
    const third = await a.call("docx.revise", { document_version_id: doc.document_version_id, amend: { remove: [5], add: [{ anchor: "收到发货款之日起60日内", proposed_text: "2027年1月25日前" }] } });
    assert.equal(third.status, "applied", JSON.stringify(third).slice(0, 1200));
    assert.deepEqual(third.amend, { base: 6, replaced: 0, removed: 1, added: 1, total: 6 });
    paras = await cleanText(third.clean.artifact_version_id);
    assert.deepEqual(rowOf(paras, "质保金"), ["质保金", "10%", "160,000", "验收合格满12个月之日起10日内"], "删掉的那条回到原文");
    assert.ok(paras.includes("4.1 乙方应于2027年1月25日前交货。"), "新加的一条写入");
    assert.deepEqual(rowOf(paras, "定金"), ["定金", "10%", "960,000", "本合同签订之日起5个工作日内"], "其余修改照旧");
    assert.deepEqual(revisions().map((r) => r.version).length, 2, "新版本，旧版本保留");

    // 既给 patches 又给 amend：报错
    assert.match(await a.fail("docx.revise", { document_version_id: doc.document_version_id, patches: SIX, amend: {} }), /二者择一/);
    // 序号越界：报清楚的错（上一次清单 6 条）
    assert.match(await a.fail("docx.revise", { document_version_id: doc.document_version_id, amend: { remove: [7] } }), /1～6 之间/);
  } finally {
    await a.close();
  }
});

test("补交：没有上一次清单时报错；另一个任务、另一份文件的清单不串；试写之后用 amend: {} 正式写入不必重发", { timeout: 180_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "设备采购合同修订 不串", stance: "买方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-10" } });
  const doc = await importBytes(tk.inv, matter.matter_id, "设备采购合同（乙方稿）.docx", purchaseContract(), DOCX_MIME);
  const other = await importBytes(tk.inv, matter.matter_id, "设备采购合同（第二份）.docx", purchaseContract(), DOCX_MIME);
  const a = await reviseAgent(matter.matter_id, "dry-first");
  const b = await reviseAgent(matter.matter_id, "another-run");
  try {
    assert.match(await a.fail("docx.revise", { document_version_id: doc.document_version_id, amend: { remove: [1] } }), /本任务还没有对这份文件提交过修改清单，请用 patches 提交完整清单/);
    const patches = [SIX[0], { anchor: "30%", paragraph_hint: "定金｜比例", proposed_text: "10%" }, SIX[2], SIX[3]];
    const dry = await a.call("docx.revise", { document_version_id: doc.document_version_id, dry_run: true, patches });
    assert.equal(dry.status, "preview", JSON.stringify(dry).slice(0, 800));
    assert.match(dry.note, /amend: \{\}/);
    // 同一任务、另一份文件：没有清单
    assert.match(await a.fail("docx.revise", { document_version_id: other.document_version_id, amend: {} }), /还没有对这份文件提交过/);
    // 另一个任务、同一份文件：没有清单
    assert.match(await b.fail("docx.revise", { document_version_id: doc.document_version_id, amend: {} }), /还没有对这份文件提交过/);
    // 试写通过后照试写的清单正式写入
    const out = await a.call("docx.revise", { document_version_id: doc.document_version_id, amend: {} });
    assert.equal(out.status, "applied", JSON.stringify(out).slice(0, 800));
    assert.equal(out.applied, 4);
    assert.deepEqual(out.amend, { base: 4, replaced: 0, removed: 0, added: 0, total: 4 });
    const paras = await cleanText(out.clean.artifact_version_id);
    assert.deepEqual(rowOf(paras, "质保金"), ["质保金", "10%", "160,000", "验收合格满12个月之日起10日内"]);
    // 清单存在库里（任务可能跨进程恢复），事项删除时随事项删除
    const row = tk.kernel.db.get<{ outcome: string; patches: string }>(`SELECT outcome, patches FROM revise_submissions WHERE run_id = ? AND document_version_id = ?`, [a.live.rid, doc.document_version_id]);
    assert.equal(row?.outcome, "applied");
    assert.equal(JSON.parse(row!.patches).length, 4);
  } finally {
    await a.close();
    await b.close();
  }
});
