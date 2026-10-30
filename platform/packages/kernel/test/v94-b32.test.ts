/**
 * v9.4 第 32 批：docx.render_report v4 节内表格（合同价款表、设备清单、证据目录）。
 * - Agent 经本机端点出带表格的文书：格子里的代号导出时还原成真名、无残留代号；格子里的【待填】计入签发前的待补占位；
 *   成果登记写明表格数；
 * - 格数与表头不符、列数或行数超限、格子是对象：整份不生成（不登记成果），逐条说明哪一节哪一行，供模型改正后重交；
 * - 整数格转成文字、空值写空格；带小数的数字与真假值不收（复核 A-04）；没有表头只报一次（A-05）；表格里不认识的字段经 schema 拒绝。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, extractParagraphs, readZipText } from "@zr-legal/docx-engine";
import { findTokens } from "@zr-legal/tokenizer";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { artifactText } from "../src/services/artifact-citations.ts";
import { placeholdersOf } from "../src/services/placeholders.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b32-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("第 32 批：带表格的文书——格子里的代号导出还原、待填计入占位、成果登记表格数；格数不符或超限整份不生成并逐条说明", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "设备买卖合同起草", stance: "买方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-30" } });
  await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "王建国", kind: "person" });
  const sheet = createDocx("交易要点", [{ heading: "联系人", paragraphs: ["卖方联系人王建国，负责设备交付与安装调试。"] }]);
  const doc = await importBytes(tk.inv, matter.matter_id, "交易要点.docx", sheet, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const live = liveTaskIdentity(tk, matter.matter_id, "b32_table");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "起草设备买卖合同", document_version_ids: [doc.document_version_id] }), live.rid]);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const raw = async (name: string, args: unknown) =>
    (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
  const call = async (name: string, args: unknown) => {
    const r = await raw(name, args);
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r)}`);
    return r.result.structuredContent;
  };
  const reports = () => tk.kernel.db.all<{ id: string }>(`SELECT artifact_version_id AS id FROM artifact_versions WHERE run_id = ? AND kind = 'agent_report'`, [live.rid]).length;

  const list = await call("materials.list", {});
  const excerpt = await call("materials.read_excerpt", { parse_version_id: list.materials[0].parse_version_id });
  const nameToken = findTokens(excerpt.text).find((t: string) => t.startsWith("〔自然人"));
  assert.ok(nameToken, `材料里的自然人姓名已令牌化：${excerpt.text}`);

  // 1. 格数不符：整份不生成、不登记成果，逐条说明哪一节哪一行
  const columns = ["序号", "设备名称", "数量", "单价（元）"];
  const bad = await raw("docx.render_report", {
    title: "设备买卖合同",
    sections: [
      { heading: "第一条 标的", paragraphs: ["1.1 设备如下表："], table: { columns, rows: [["1", "立式加工中心", 2, "380,000.00"], ["2", "数控车床", "1"]] } },
      { heading: "附件", paragraphs: [], table: { columns: Array.from({ length: 11 }, (_, i) => `列${i + 1}`), rows: [Array.from({ length: 11 }, () => "x")] } },
    ],
  });
  assert.equal(bad.result?.isError, true, JSON.stringify(bad));
  const msg = JSON.stringify(bad.result.content);
  assert.match(msg, /整份文书未生成/);
  assert.match(msg, /第 1 节（第一条 标的）的表格第 2 行有 3 格，表头是 4 列/);
  assert.match(msg, /第 2 节（附件）的表格有 11 列，超过 10 列/);
  const nested = await raw("docx.render_report", { title: "设备买卖合同", sections: [{ heading: "", paragraphs: [], table: { columns: ["a"], rows: [[{ text: "x" }]] } }] });
  assert.equal(nested.result?.isError, true);
  assert.match(JSON.stringify(nested.result.content), /第 1 行有格子不是文字或数字/);
  const extra = await raw("docx.render_report", { title: "设备买卖合同", sections: [{ heading: "", paragraphs: [], table: { columns: ["a"], rows: [["x"]], widths: [100] } }] });
  assert.equal(extra.result?.isError, true, "表格里不认识的字段经 schema 拒绝");
  // 复核 A-04：带小数的数字（金额经 JSON 丢了末尾的 0）与真假值不收
  const decimal = await raw("docx.render_report", { title: "设备买卖合同", sections: [{ heading: "", paragraphs: [], table: { columns: ["项目", "金额（元）"], rows: [["预付款", 380000.5], ["含税", true]] } }] });
  assert.equal(decimal.result?.isError, true);
  assert.match(JSON.stringify(decimal.result.content), /第 1 行有带小数的数字：金额按文书写法写成文字/);
  assert.match(JSON.stringify(decimal.result.content), /第 2 行有格子不是文字或数字/);
  // 复核 A-05：没有表头只报一次，不逐行重复
  const noHead = await raw("docx.render_report", { title: "设备买卖合同", sections: [{ heading: "", paragraphs: [], table: { columns: [], rows: [["a"], ["b"]] } }] });
  assert.equal(noHead.result?.isError, true);
  assert.match(JSON.stringify(noHead.result.content), /没有表头列/);
  assert.doesNotMatch(JSON.stringify(noHead.result.content), /表头是 0 列/);
  assert.equal(reports(), 0, "格式有误的文书不登记成果");

  // 2. 改正后重交：数字格转文字、空值写空格；格子里的代号与【待填】
  const report = await call("docx.render_report", {
    title: "设备买卖合同",
    sections: [
      { heading: "第一条 标的与价款", paragraphs: ["1.1 买方向卖方购买下列设备："], table: { columns, rows: [["1", "立式加工中心", 2, "380,000.00"], ["2", "数控车床", 1, "【待填】"], ["3", "备件包", null, "随机附送"]] } },
      { heading: "", paragraphs: ["1.2 合同总价以上表金额合计为准。"] },
      { heading: "第二条 联系人", paragraphs: [], table: { columns: ["事项", "联系人"], rows: [["交付与安装调试", `卖方：${nameToken}`]] } },
    ],
  });
  assert.match(report.artifact_version_id, /^artv_/);
  assert.equal(reports(), 1);
  const art = tk.kernel.db.get<{ manifest: string; storage_uri: string; filename: string }>(`SELECT manifest, storage_uri, filename FROM artifact_versions WHERE artifact_version_id = ?`, [report.artifact_version_id])!;
  assert.deepEqual(JSON.parse(art.manifest), { tool: "docx.render_report", sections: 3, tables: 2 });

  // 登记的字节是令牌形态；格子里的【待填】计入签发前的待补占位
  const stored = tk.kernel.blobs.read(art.storage_uri);
  const storedText = artifactText(art.filename, stored);
  assert.equal(typeof storedText, "string");
  assert.ok(String(storedText).includes(nameToken!), "登记的字节里是代号");
  assert.equal(placeholdersOf(String(storedText)).total, 1, "格子里的【待填】计入待补占位");
  const storedXml = readZipText(stored, "word/document.xml") ?? "";
  assert.match(storedXml, /<w:t xml:space="preserve">2<\/w:t>/, "数字格转成文字");

  // 导出还原：格子里是真名、无残留代号
  const dl = await tk.inv("artifacts.download", { artifact_version_id: report.artifact_version_id });
  const out = Buffer.from(dl.data_base64, "base64");
  const outText = extractParagraphs(out).map((p) => p.text).join("\n");
  assert.match(outText, /卖方：王建国/);
  assert.equal(findTokens(outText).length, 0);
  assert.ok(dl.tokens_restored >= 1);
  const outXml = readZipText(out, "word/document.xml") ?? "";
  assert.equal((outXml.match(/<w:tbl>/g) ?? []).length, 2, "导出套版式后两张表都在");
  assert.ok(outXml.indexOf("</w:tbl>") < outXml.indexOf("1.2 合同总价"), "表后正文接在表后");
});
