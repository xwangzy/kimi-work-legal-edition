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
    assert.match(dry.header_footer_note, /页眉页脚不会改到/);

    const done = await call("docx.revise", { document_version_id: doc.document_version_id, patches: [rename, unrelated] });
    assert.equal(done.status, "applied");
    assert.equal(done.header_footer?.length, 1, "正式写入后同样提示");
    // 只提示、不改写：修订稿的页眉仍是原文
    const art = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [done.revision.artifact_version_id])!;
    const header = readZipEntries(tk.kernel.blobs.read(art.storage_uri)).get("word/header1.xml")!.toString("utf8");
    assert.ok(header.includes("北京云栈软件技术有限公司"));

    const only = await call("docx.revise", { document_version_id: doc.document_version_id, patches: [unrelated], dry_run: true });
    assert.equal(only.header_footer, undefined, "与页眉无关的修改不报");
  } finally {
    await agent.close();
  }
});
