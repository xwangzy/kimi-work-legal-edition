/**
 * 第 35 批真实走查 R3：助手拟的意见书标题带当事人名（令牌形态），成果文件名成了“关于〔自然人·…〕劳动合同解除……意见书.docx”，
 * 律师下载的文件名里是代号。导出时文件名与正文一样还原真名；应用内预览（restore:false）仍是代号形态。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { findTokens } from "@zr-legal/tokenizer";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b35-name-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("成果文件名里的代号导出时还原真名，预览不还原", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "劳动争议", stance: "用人单位", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-03" } });
  await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "方景行", kind: "person" });
  const doc = await importBytes(tk.inv, matter.matter_id, "情况说明.txt", Buffer.from("员工方景行于2026年9月离职。", "utf8"), "text/plain");
  const live = liveTaskIdentity(tk, matter.matter_id, "b35_name");
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
    const excerpt = await call("materials.read_excerpt", { parse_version_id: doc.parse_version_id, char_start: 0, char_end: 100 });
    const tok = findTokens(excerpt.text).find((t: string) => t.startsWith("〔自然人"));
    assert.ok(tok, "材料里的姓名是代号");
    const r = await call("docx.render_report", { title: `关于${tok}劳动合同解除事项的法律意见书`, sections: [{ heading: "一、结论", paragraphs: [`${tok}的解除合法性存在风险。`] }] });
    const art = tk.kernel.db.get<{ filename: string }>(`SELECT filename FROM artifact_versions WHERE artifact_version_id = ?`, [r.artifact_version_id])!;
    assert.ok(art.filename.includes(tok!), "登记的文件名是令牌形态");

    const dl = await tk.inv("artifacts.download", { artifact_version_id: r.artifact_version_id });
    assert.equal(dl.filename, "关于方景行劳动合同解除事项的法律意见书.docx");
    const pdf = await tk.inv("artifacts.print_html", { artifact_version_id: r.artifact_version_id });
    assert.equal(pdf.filename, "关于方景行劳动合同解除事项的法律意见书.pdf", "导出 PDF 的文件名同样还原");
    const preview = await tk.inv("artifacts.download", { artifact_version_id: r.artifact_version_id, restore: false });
    assert.ok(String(preview.filename).includes(tok!), "预览不还原");
  } finally {
    await agent.close();
  }
});
