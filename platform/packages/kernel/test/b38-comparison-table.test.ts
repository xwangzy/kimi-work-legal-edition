/**
 * V13 第 38 批（W2 律师评分 16/24）：律师要求“因为增删条款引起的条号、援引条号要跟着改，并在对照表里单独列出来”。
 * 原《修改对照表》把援引联动和按意见的修改混在一张表里，顺延清单只列前 20 条（W2 有 40 多处顺延，被截断）。
 * 现在分三部分：一、按修改意见的修改；二、因增删条款引起的援引条号联动；三、条款编号顺延（原件 → 修订后，全部列出）；条款栏写“原 X（现 Y）”。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createStyledDocx, extractParagraphs, readZipEntries, writeZip } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { isReferenceOnlyChange } from "../src/tools/tools/revise.ts";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b38-compare-firm");
});
after(async () => {
  await tk.kernel.close();
});

function autoNumbered(): Buffer {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const num = (ilvl: number) => `<w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr></w:pPr>`;
  const para = (t: string, pPr = "") => `<w:p>${pPr}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const body = [
    para("仓储服务合同"),
    para("服务内容", num(0)),
    para("乙方提供仓储服务。", num(1)),
    para("乙方可将货物调拨至其他仓库。", num(1)),
    para("乙方应每月盘点。", num(1)),
    para("保证金", num(0)),
    para("甲方支付履约保证金人民币500,000元。", num(1)),
    para("违约责任", num(0)),
    para("乙方违反第1.3款约定的，每逾期一日支付违约金1,000元。", num(1)),
    para("本合同第三条约定的违约金不影响其他救济。", num(1)),
  ].join("");
  const files = readZipEntries(createStyledDocx([{ kind: "p", runs: [{ text: "占位" }] }], undefined, null, { mark: false }));
  files.set("word/document.xml", Buffer.from(files.get("word/document.xml")!.toString("utf8").replace(/<w:body>[\s\S]*?(<w:sectPr)/, `<w:body>${body}$1`)));
  files.set("word/numbering.xml", Buffer.from(`<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="第%1条"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:isLgl/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`));
  return writeZip([...files.entries()].map(([name, data]) => ({ name, data })));
}

test("只改了援引条号的段落识别为联动；改了实质内容的不算", () => {
  assert.equal(isReferenceOnlyChange("乙方违反第4.4款约定的", "乙方违反第4.3款约定的"), true);
  assert.equal(isReferenceOnlyChange("依第十一条向乙方主张", "依第十二条向乙方主张"), true);
  assert.equal(isReferenceOnlyChange("超过第4.4款约定标准", "超过第4.3款约定的标准"), false);
  assert.equal(isReferenceOnlyChange("保证金50万元", "保证金20万元"), false);
});

test("修改对照表分三部分：按意见的修改、援引条号联动、编号顺延全部列出；条款栏写原号与现号", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "对照表分列", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-07" } });
  const doc = await importBytes(tk.inv, matter.matter_id, "仓储服务合同（乙方提供稿）.docx", autoNumbered(), DOCX_MIME);
  const live = liveTaskIdentity(tk, matter.matter_id, "b38_cmp");
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  try {
    const r = (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "docx.revise", arguments: { document_version_id: doc.document_version_id, patches: [
        { anchor: "乙方可将货物调拨至其他仓库。", proposed_text: "" },
        { anchor: "人民币500,000元", proposed_text: "人民币200,000元" },
        { anchor: "违反第1.3款约定的", proposed_text: "违反第1.2款约定的" },
        { anchor: "乙方应每月盘点。", proposed_text: "乙方应于每月最后一个工作日盘点。" },
      ] } } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
    const done = r.result.structuredContent;
    assert.equal(done.status, "applied", JSON.stringify(r).slice(0, 400));
    const art = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [done.comparison.artifact_version_id])!;
    const t = extractParagraphs(tk.kernel.blobs.read(art.storage_uri)).map((x) => x.text);
    const i1 = t.indexOf("一、按修改意见的修改");
    const i2 = t.indexOf("二、因增删条款引起的援引条号联动");
    const i3 = t.indexOf("三、条款编号顺延（原件 → 修订后）");
    assert.ok(i1 > 0 && i2 > i1 && i3 > i2, t.join(" / "));
    const own = t.slice(i1, i2).join("\n");
    const linked = t.slice(i2, i3).join("\n");
    const shift = t.slice(i3).join("\n");
    assert.match(own, /人民币200,000元/);
    assert.doesNotMatch(own, /违反第1\.2款/, "援引联动不混在按意见的修改里");
    assert.match(linked, /原 3\.1|3\.1/);
    assert.match(linked, /违反第1\.2款/);
    assert.match(shift, /1\.3[\s\S]*1\.2/, "顺延清单列出 1.3 → 1.2（这一段本身也被修改过：W2 里这类段落曾漏出顺延清单）");
    assert.match(own, /原 1\.3（现 1\.2）/, "改过又顺延的段落，条款栏写原号与现号");
  } finally {
    await agent.close();
  }
});
