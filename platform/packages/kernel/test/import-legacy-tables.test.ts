/**
 * v9.3 第 15 批 B-11（评审 Z1：“.doc/.wps 不支持”、DOCX 表格被拆成一格一行）：
 * - 旧版 Word / WPS / Excel / RTF：按扩展名或文件头认出，提示律师在原软件里另存为新格式（改了扩展名的旧文件也认得）；
 * - DOCX 表格按行写成“| 单元格 | 单元格 |”，单元格内多段连成一格、嵌套表压成一格；律师能在事项里读到、Agent 能按行理解表格。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeRawZip } from "@zr-legal/docx-engine";
import { docxXmlToText, parseDocument } from "../src/services/parser.ts";
import { makeKernel, importBytes, type TestKernel } from "./helpers.ts";

let tk: TestKernel | null = null;
after(async () => {
  await tk?.kernel.close().catch(() => {});
});

const p = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const tc = (...paras: string[]) => `<w:tc><w:tcPr/>${paras.map(p).join("")}</w:tc>`;
const tr = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
const tbl = (...rows: string[]) => `<w:tbl><w:tblPr/>${rows.join("")}</w:tbl>`;
const doc = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
const docx = (body: string) => writeRawZip([{ name: "[Content_Types].xml", data: Buffer.from("<Types/>") }, { name: "word/document.xml", data: Buffer.from(doc(body)) }]);

test("B-11 DOCX 表格按行：表头与每行一行，单元格多段连成一格，竖线转全角，嵌套表压成一格", () => {
  const xml = doc(
    p("付款安排如下：") +
      tbl(tr(tc("期次"), tc("金额"), tc("条件")), tr(tc("第一期"), tc("300,000 元"), tc("签约后 5 日内", "凭发票")), tr(tc("第二期"), tc("A|B"), tc(tbl(tr(tc("交付"), tc("验收")), tr(tc("10 日"), tc("30 日")))))) +
      p("以上金额含税。"),
  );
  assert.equal(
    docxXmlToText(xml),
    ["付款安排如下：", "| 期次 | 金额 | 条件 |", "| 第一期 | 300,000 元 | 签约后 5 日内 凭发票 |", "| 第二期 | A｜B | ｜ 交付 ｜ 验收 ｜；｜ 10 日 ｜ 30 日 ｜ |", "以上金额含税。"].join("\n"),
  );
  // 嵌套表的竖线也转全角：外层表的列数不被打乱
  // 没有表格的文档不变
  assert.equal(docxXmlToText(doc(p("甲") + p("乙"))), "甲\n乙");
  const parsed = parseDocument("付款.docx", "application/octet-stream", docx(tbl(tr(tc("甲"), tc("乙")))));
  assert.equal(parsed.text, "| 甲 | 乙 |");
  assert.ok(parsed.qualityFlags.includes("tables_as_rows"));
  assert.ok(!parseDocument("无表.docx", "", docx(p("甲"))).qualityFlags.includes("tables_as_rows"));
});

test("B-11 旧格式：按扩展名与文件头认出，提示另存为新格式（不只说“不支持”）", () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
  const cases: [string, Buffer, RegExp][] = [
    ["起诉状.doc", ole, /旧版 Word 或 WPS 文字.*另存为”Word 文档（\.docx）/],
    ["合同.wps", ole, /旧版 Word 或 WPS 文字/],
    ["流水.xls", ole, /旧版 Excel 或 WPS 表格.*Excel 工作簿（\.xlsx）/],
    ["流水.et", ole, /旧版 Excel 或 WPS 表格/],
    ["改了名的旧文件.docx", ole, /旧版 Word 或 WPS 文字/],
    ["改了名的旧表格.xlsx", ole, /旧版 Excel 或 WPS 表格/],
    ["函.rtf", Buffer.from("{\\rtf1\\ansi 你好}"), /RTF 文档/],
    ["改了名的.txt", Buffer.from("{\\rtf1\\ansi x}"), /RTF 文档/],
  ];
  for (const [name, buf, re] of cases) {
    assert.throws(() => parseDocument(name, "application/octet-stream", buf), (e: any) => e.code === "unsupported_file" && re.test(e.message) && e.detail?.legacy_format === true, name);
  }
});

test("B-11 事项导入：旧格式给出另存提示；带表格的 DOCX 导入后可读到按行的表格", async () => {
  tk = await makeKernel();
  const m = (await tk.inv("matters.create", { title: "表格导入", stance: "买方", consent_status: "not_required" })).matter.matter_id as string;
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
  await assert.rejects(importBytes(tk.inv, m, "起诉状.doc", ole, "application/msword"), /另存为/);
  const r = await importBytes(tk.inv, m, "付款表.docx", docx(tbl(tr(tc("期次"), tc("金额")), tr(tc("第一期"), tc("30 万元")))), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const row = tk.kernel.db.get<{ content: string }>(
    `SELECT pt.content FROM parse_texts pt JOIN parse_versions pv ON pv.parse_version_id = pt.parse_version_id WHERE pv.document_version_id = ?`,
    [r.document_version_id],
  );
  assert.match(row?.content ?? "", /\| 第一期 \| 30 万元 \|/);
});

test("复核 R15B-07：表格按行读取后，跨单元格或含“｜”的摘录在定位视图里仍能定位", async () => {
  const { locateQuote } = await import("../src/services/review-cards.ts");
  // 定位视图里每个单元格各占一段；材料快照里是“| 第一期 | 300,000 元 |”，原有的“|”写成“｜”
  const view = "付款安排如下：\n期次\n金额\n第一期\n300,000 元\nA|B\n以上金额含税。";
  assert.equal(locateQuote(view, "第一期 | 300,000 元").status, "located");
  assert.equal(locateQuote(view, "A｜B").status, "located");
  assert.equal(locateQuote(view, "第二期 | 300,000 元").status, "not_found");
});
