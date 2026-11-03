/**
 * 第 35 批真实走查 R5：律师要求“首部、鉴于条款、页眉和签署页”的乙方名称统一改正。材料文字与 docx.revise 只覆盖正文，
 * 页眉里的错名改不到，原先也不提示。现在试写与正式写入都在原件页眉页脚里查一遍这次改掉的原文，查到的列给助手（不改写页眉页脚）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createStyledDocx, readZipEntries, writeZip } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "revise-hf-firm");
});
after(async () => {
  await tk.kernel.close();
});

const p = (t: string) => ({ kind: "p" as const, runs: [{ text: t }] });
/** 正文与页眉都写着错名的合同：页眉部件按 Word 的写法另放一个 header1.xml。 */
function contractWithHeader(): Buffer {
  const base = createStyledDocx(
    [
      { kind: "title", text: "软件许可及实施服务合同" },
      p("乙方：北京云栈软件技术有限公司"),
      { kind: "h1", text: "第一条 定义" },
      p("1.1 本合同项下的系统指乙方提供的质量管理系统。"),
    ],
    undefined,
    null,
    { mark: false },
  );
  const files = readZipEntries(base);
  files.set(
    "word/header1.xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t xml:space="preserve">北京云栈软件技术有限公司 · 软件许可及实施服务合同</w:t></w:r></w:p></w:hdr>`,
      "utf8",
    ),
  );
  return writeZip([...files].map(([name, data]) => ({ name, data })));
}

test("改正文里的名称时，原件页眉里同一处原文列给助手；与页眉无关的修改不报", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "云栈合同修改", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-03" } });
  const doc = await importBytes(tk.inv, matter.matter_id, "软件许可及实施服务合同（云栈软件提供稿）.docx", contractWithHeader(), DOCX_MIME);
  const live = liveTaskIdentity(tk, matter.matter_id, "b35_hf");
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) => {
    const r = (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r).slice(0, 400)}`);
    return r.result.structuredContent;
  };
  try {
    const rename = { anchor: "乙方：北京云栈软件技术有限公司", proposed_text: "乙方：北京云栈软件科技有限公司" };
    const unrelated = { anchor: "质量管理系统", proposed_text: "质量管理系统（QMS）" };
    const dry = await call("docx.revise", { document_version_id: doc.document_version_id, patches: [rename, unrelated], dry_run: true });
    assert.equal(dry.status, "preview");
    assert.equal(dry.header_footer?.length, 1, JSON.stringify(dry));
    assert.equal(dry.header_footer[0].part, "页眉");
    assert.deepEqual(dry.header_footer[0].patches, [1], "只有改名那一条在页眉里有同一处原文");
    assert.match(dry.header_footer_note, /paragraph_hint 写“页眉”或“页脚”/, "V10 第 36 批：提示补一条页眉修改，不再只请律师手工改");
    assert.ok(dry.header_footer_text?.some((x: any) => x.part === "页眉" && x.text.includes("北京云栈软件技术有限公司")), "页眉原文给助手照抄锚点");

    const done = await call("docx.revise", { document_version_id: doc.document_version_id, patches: [rename, unrelated] });
    assert.equal(done.status, "applied");
    assert.equal(done.header_footer?.length, 1, "正式写入后同样提示");
    // 只改正文的这次提交：修订稿的页眉仍是原文（页眉要另写一条 paragraph_hint“页眉”的修改，见下一用例）
    const art = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [done.revision.artifact_version_id])!;
    const header = readZipEntries(tk.kernel.blobs.read(art.storage_uri)).get("word/header1.xml")!.toString("utf8");
    assert.ok(header.includes("北京云栈软件技术有限公司"));

    const only = await call("docx.revise", { document_version_id: doc.document_version_id, patches: [unrelated], dry_run: true });
    assert.equal(only.header_footer, undefined, "与页眉无关的修改不报");
  } finally {
    await agent.close();
  }
});

test("V10 第 36 批：paragraph_hint 写“页眉”的修改写进页眉（原生修订），清洁稿接受；对照表单列“页眉”一行；锚点不在页眉里整体不写", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { sanitizeDocx, headerFooterParagraphs, extractParagraphs } = await import("@zr-legal/docx-engine");
  const { matter } = await tk.inv("matters.create", { title: "云栈合同页眉", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-03" } });
  const doc = await importBytes(tk.inv, matter.matter_id, "软件许可及实施服务合同（页眉）.docx", contractWithHeader(), DOCX_MIME);
  const live = liveTaskIdentity(tk, matter.matter_id, "v10_hf");
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) => {
    const r = (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r).slice(0, 400)}`);
    return r.result.structuredContent;
  };
  try {
    const body = { anchor: "乙方：北京云栈软件技术有限公司", proposed_text: "乙方：北京云栈软件科技有限公司", comment: "乙方名称以营业执照为准" };
    const head = { anchor: "北京云栈软件技术有限公司 · 软件许可", proposed_text: "北京云栈软件科技有限公司 · 软件许可", paragraph_hint: "页眉" };
    const dry = await call("docx.revise", { document_version_id: doc.document_version_id, patches: [body, head], dry_run: true });
    assert.equal(dry.status, "preview", JSON.stringify(dry).slice(0, 400));
    assert.equal(dry.header_footer, undefined, "页眉已有修改，不再列为遗漏");
    assert.equal(dry.header_footer_changes?.[0]?.part, "页眉");
    assert.match(dry.header_footer_changes[0].after, /^北京云栈软件科技有限公司 · 软件许可及实施服务合同$/);

    const done = await call("docx.revise", { document_version_id: doc.document_version_id, patches: [body, head] });
    assert.equal(done.status, "applied", JSON.stringify(done).slice(0, 400));
    const rev = tk.kernel.blobs.read(tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [done.revision.artifact_version_id])!.storage_uri);
    const hx = readZipEntries(rev).get("word/header1.xml")!.toString("utf8");
    assert.match(hx, /<w:del\b[^>]*><w:r><w:delText xml:space="preserve">技术<\/w:delText><\/w:r><\/w:del><w:ins\b[^>]*><w:r><w:t xml:space="preserve">科技<\/w:t>/, "页眉里是原生修订（删“技术”插“科技”），不是直接改字");
    assert.ok(!hx.includes("commentRangeStart"), "页眉里不挂批注");
    assert.deepEqual(headerFooterParagraphs(sanitizeDocx(rev).docx).find((x) => x.part === "header")!.texts, ["北京云栈软件科技有限公司 · 软件许可及实施服务合同"], "清洁稿接受页眉修订");
    const cmp = extractParagraphs(tk.kernel.blobs.read(tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [done.comparison.artifact_version_id])!.storage_uri)).map((x) => x.text);
    assert.ok(cmp.includes("页眉"), `对照表单列页眉一行：${cmp.join(" / ")}`);

    // 锚点不在页眉里：整体不写，结果附页眉原文供照抄
    const bad = await call("docx.revise", { document_version_id: doc.document_version_id, patches: [{ ...head, anchor: "云栈软件技术公司" }] });
    assert.equal(bad.status, "not_applied");
    assert.equal(bad.conflicts[0].reason, "anchor_not_in_view");
    assert.ok(bad.header_footer_text?.length > 0);
  } finally {
    await agent.close();
  }
});

test("修改对照表的“条款”栏用律师的说法：段首条款号、表格的行与列、段首几个字，不写“第 N 段”（R5 律师评分）", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { extractParagraphs } = await import("@zr-legal/docx-engine");
  const { matter } = await tk.inv("matters.create", { title: "对照表位置", stance: "委托方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-03" } });
  const body = createStyledDocx(
    [
      { kind: "title", text: "软件许可及实施服务合同" },
      p("乙方：北京云栈软件技术有限公司"),
      p("2.1 本合同总价为人民币2,860,000元，构成如下："),
      { kind: "table", rows: [[[{ text: "项目" }], [{ text: "金额（元）" }]], [[{ text: "软件许可费" }], [{ text: "1,560,000.00" }]], [[{ text: "合计" }], [{ text: "2,860,000.00" }]]] },
    ],
    undefined,
    null,
    { mark: false },
  );
  const doc = await importBytes(tk.inv, matter.matter_id, "软件许可合同.docx", body, DOCX_MIME);
  const live = liveTaskIdentity(tk, matter.matter_id, "b35_place");
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  try {
    const r = (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "docx.revise", arguments: { document_version_id: doc.document_version_id, patches: [
        { anchor: "北京云栈软件技术有限公司", proposed_text: "北京云栈软件科技有限公司" },
        { anchor: "2,860,000元", proposed_text: "2,580,000元" },
        { anchor: "2,860,000.00", proposed_text: "2,580,000.00" },
      ] } } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
    const done = r.result.structuredContent;
    assert.equal(done.status, "applied", JSON.stringify(r).slice(0, 400));
    const art = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [done.comparison.artifact_version_id])!;
    const cells = extractParagraphs(tk.kernel.blobs.read(art.storage_uri)).map((x) => x.text);
    assert.ok(cells.includes("2.1"), `段首手打的款号：${cells.join(" / ")}`);
    assert.ok(cells.some((x) => x === "第 2.1 款下表格“合计”行·金额（元）"), `表格的格子写行与列：${cells.join(" / ")}`);
    assert.ok(cells.some((x) => /^“乙方：北京云栈软件技术有/.test(x)), "没有编号的段落写段首几个字");
    assert.ok(!cells.some((x) => /^第 \d+ 段$/.test(x)), "不写内部段落号");
  } finally {
    await agent.close();
  }
});
