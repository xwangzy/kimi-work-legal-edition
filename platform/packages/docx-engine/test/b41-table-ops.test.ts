/**
 * V16 第 41 批真实走查 D1（运维服务合同按 10 条意见修订）：
 * - “在第 6.1 款（含其后表格）之后插入新的一款”——段后插入只能落在 6.1 与表格之间或落进单元格，助手如实回报“未写入”；
 * - “附件三表格在‘甲方运维对接人’一行之后新增一行”——工具不能加表格行；
 * - 合计行前三格横向合并，提示“5.2｜合计｜金额（元）”对不上列名，助手试了三次才定位。
 * 现在：表后插入（新款沿用表前那一段的格式与自动编号）、表格新增一行（照抄该行单元格属性，纵向合并续接，整行标为插入）、
 * 删除表格一行（接受修订后整行消失，合并组的类别栏移到下一行）、列名按网格列取。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "@zr-legal/domain";
import { applyRevisionsToDocx, assertWellFormed, changeHunks, createDocx, docxListLabels, enclosingElement, extractParagraphs, paragraphCells, readZipEntries, removeDeletedRows, sanitizeDocx, writeZip, type RevisionOp } from "../src/index.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const NUMBERING = `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}>
<w:abstractNum w:abstractNumId="7"><w:multiLevelType w:val="multilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="第%1条"/></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:isLgl/><w:lvlText w:val="%1.%2"/></w:lvl>
</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num></w:numbering>`;
const para = (text: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const num = (ilvl: number) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr>`;
const tc = (text: string, tcPr = "", rPr = "") => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>${tcPr}</w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`;
const tr = (cells: string[], trPr = "") => `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ""}${cells.join("")}</w:tr>`;
const tbl = (rows: string[]) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${rows.join("")}</w:tbl>`;

function withBody(body: string): Buffer {
  const files = readZipEntries(createDocx("合同", [{ heading: "占位", paragraphs: ["占位"] }]));
  files.set("word/document.xml", Buffer.from(files.get("word/document.xml")!.toString("utf8").replace(/<w:body>[\s\S]*?(<w:sectPr)/, `<w:body>${body}$1`)));
  files.set("word/numbering.xml", Buffer.from(NUMBERING));
  return writeZip([...files.entries()].map(([name, data]) => ({ name, data })));
}

/** 第五条付款（表：期次｜费用类别｜付款节点｜金额，合计行前三格横向合并）、第六条服务水平（6.1 后跟表）、附件联系人表（首列纵向合并）。 */
const contract = () =>
  withBody(
    [
      para("服务费与付款", num(0)),
      para("服务费按下表分期支付：", num(1)),
      tbl([
        tr([tc("期次"), tc("费用类别"), tc("付款节点"), tc("金额（元）")], "<w:tblHeader/>"),
        tr([tc("第一期"), tc("升级服务费"), tc("合同生效"), tc("198,000")]),
        tr([tc("第二期"), tc("升级服务费"), tc("上线验收"), tc("396,000")]),
        tr([tc("合计", '<w:gridSpan w:val="3"/>', "<w:b/>"), tc("594,000", "", "<w:b/>")]),
      ]),
      para("甲方应在收到发票之日起15个工作日内付款。", num(1)),
      para("服务水平", num(0)),
      para("乙方应按下表约定的时限响应和恢复故障：", num(1)),
      tbl([
        tr([tc("故障等级"), tc("响应时间"), tc("恢复时间"), tc("单次违约金（元）")]),
        tr([tc("一级"), tc("15分钟"), tc("4小时"), tc("5,000")]),
        tr([tc("二级"), tc("8小时"), tc("24小时"), tc("2,000")]),
      ]),
      para("乙方工程师应在每次故障恢复后24小时内提交故障报告。", num(1)),
      para("违约责任", num(0)),
      para("乙方未达到第2.2款约定标准的，应支付违约金。", num(1)),
      para("附件三 联系人"),
      tbl([
        tr([tc("类别"), tc("角色"), tc("姓名"), tc("电话")]),
        tr([tc("联系人", '<w:vMerge w:val="restart"/>'), tc("甲方项目负责人"), tc("宋知微"), tc("0573-82910001")]),
        tr([tc("", "<w:vMerge/>"), tc("甲方运维对接人"), tc("阮青禾"), tc("0573-82910002")]),
        tr([tc("", "<w:vMerge/>"), tc("乙方项目经理"), tc("蒋叙白"), tc("0512-67550003")]),
      ]),
      para("本附件是合同的组成部分。"),
    ].join(""),
  );

const op = (id: string, anchor: string, newText: string, extra: Partial<RevisionOp> = {}): RevisionOp => ({ opId: id, anchor: { originalText: anchor, ...(extra.anchor ?? {}) } as RevisionOp["anchor"], originalHash: sha256Hex(anchor), newText, author: "测试", ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "anchor")) });
const apply = (docx: Buffer, ops: RevisionOp[]) => applyRevisionsToDocx(docx, { baselineHash: sha256Hex(docx), ops });
const docXml = (docx: Buffer) => readZipEntries(docx).get("word/document.xml")!.toString("utf8");
const texts = (docx: Buffer) => extractParagraphs(docx).map((p) => p.text);

test("表后插入：锚点是表格前那一段，新款落在整张表之后并续成 2.2，原 2.2 顺延为 2.3；新段落不在任何单元格里", () => {
  const docx = contract();
  assert.deepEqual(docxListLabels(docx).filter(Boolean), ["第一条", "1.1", "1.2", "第二条", "2.1", "2.2", "第三条", "3.1"]);
  const r = apply(docx, [op("a", "乙方应按下表约定的时限响应和恢复故障：", "发生一级故障的，乙方应在故障恢复后48小时内组织甲方召开复盘会议。", { insertAfter: true, afterTable: true, comment: "按律师意见第 2 点新增" })]);
  assert.equal(r.applied[0]!.placement, "after_table");
  const xml = docXml(r.docx);
  assertWellFormed(xml, "word/document.xml");
  const at = xml.indexOf("发生一级故障的");
  assert.equal(enclosingElement(xml, "tbl", at, "outer"), null, "新段落在表格之外");
  assert.ok(at > xml.indexOf("2,000") && at < xml.indexOf("乙方工程师应在每次故障恢复后"), "在表格之后、原 2.2 之前");
  assert.match(xml, /<w:ins [^>]*w:author="测试"[^>]*><w:r>[^<]*<w:t xml:space="preserve">发生一级故障的/, "以插入修订写入");
  const clean = sanitizeDocx(r.docx).docx;
  const labels = docxListLabels(clean);
  const t = texts(clean);
  assert.equal(labels[t.indexOf("发生一级故障的，乙方应在故障恢复后48小时内组织甲方召开复盘会议。")], "2.2");
  assert.equal(labels[t.indexOf("乙方工程师应在每次故障恢复后24小时内提交故障报告。")], "2.3");
});

test("表后插入：锚点写表格里任一格的文字也行；同一张表之后连加两款按提交顺序排列", () => {
  const r = apply(contract(), [
    op("a", "8小时", "第一款新增内容。", { insertAfter: true, afterTable: true }),
    op("b", "乙方应按下表约定的时限响应和恢复故障：", "第二款新增内容。", { insertAfter: true, afterTable: true }),
  ]);
  const clean = sanitizeDocx(r.docx).docx;
  const t = texts(clean);
  const i = t.indexOf("第一款新增内容。");
  assert.equal(t[i + 1], "第二款新增内容。");
  assert.deepEqual([docxListLabels(clean)[i], docxListLabels(clean)[i + 1]], ["2.2", "2.3"]);
  assert.equal(r.applied[0]!.formatParagraphIndex, r.applied[1]!.formatParagraphIndex, "格式都取表前那一段");
});

test("表后插入：锚点段落后面不是表格的拒绝，并说明怎么写", () => {
  assert.throws(() => apply(contract(), [op("a", "乙方工程师应在每次故障恢复后24小时内提交故障报告。", "新款。", { insertAfter: true, afterTable: true })]), /后面不是表格/);
});

test("表格新增一行：照抄该行的单元格属性，纵向合并的首列续接，整行标为插入；只写未合并的三格或写满四格都行", () => {
  for (const cellsText of ["甲方数据安全联系人｜柏庭舟｜0573-82916627", "｜甲方数据安全联系人｜柏庭舟｜0573-82916627", "\t甲方数据安全联系人\t柏庭舟\t0573-82916627"]) {
    const r = apply(contract(), [op("a", "甲方运维对接人", cellsText, { insertRowAfter: true, comment: "按律师意见第 5 点新增" })]);
    assert.equal(r.applied[0]!.placement, "row_inserted");
    const xml = docXml(r.docx);
    assertWellFormed(xml, "word/document.xml");
    const row = enclosingElement(xml, "tr", xml.indexOf("柏庭舟"), "inner")!;
    const rowXml = xml.slice(row.start, row.end);
    assert.match(rowXml, /<w:trPr>(?:(?!<\/w:trPr>)[\s\S])*<w:ins [^>]*\/><\/w:trPr>/, "行标记标为插入");
    assert.equal((rowXml.match(/<w:tc>/g) ?? []).length, 4);
    assert.match(rowXml, /<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"\/><w:vMerge\/><\/w:tcPr>/, "首列续接纵向合并");
    assert.equal((rowXml.match(/<w:jc w:val="center"\/>/g) ?? []).length, 4, "段落对齐照抄");
    assert.ok(row.start > xml.indexOf("阮青禾") && row.end < xml.indexOf("乙方项目经理"), "在“甲方运维对接人”行之后、下一行之前");
    assert.equal(xml.includes("kwl-"), false, "临时标记写完即去掉");
    // 接受全部修订：新行留下、标记去掉，表格仍是 5 行 4 列
    const cleanXml = docXml(sanitizeDocx(r.docx).docx);
    const t0 = cleanXml.indexOf("附件三 联系人");
    const table = enclosingElement(cleanXml, "tbl", cleanXml.indexOf("柏庭舟"), "outer")!;
    assert.ok(table.start > t0);
    assert.equal((cleanXml.slice(table.start, table.end).match(/<w:tr\b/g) ?? []).length, 5);
    assert.equal(/<w:ins\b/.test(cleanXml), false);
  }
});

test("表格新增一行：格数不对的拒绝并写明应有几格；表头行后新增的行不带“各页重复”", () => {
  assert.throws(() => apply(contract(), [op("a", "甲方运维对接人", "甲方数据安全联系人｜柏庭舟", { insertRowAfter: true })]), /应有 4 格（其中 1 格是纵向合并的，可以留空或不写，即写 3 格），收到 2 格/);
  assert.throws(() => apply(contract(), [op("a", "本附件是合同的组成部分。", "甲｜乙", { insertRowAfter: true })]), /锚点不在表格里/);
  const r = apply(contract(), [op("a", "期次", "第零期｜升级服务费｜签约｜0", { insertRowAfter: true })]);
  const xml = docXml(r.docx);
  const row = enclosingElement(xml, "tr", xml.indexOf("第零期"), "inner")!;
  assert.equal(xml.slice(row.start, row.end).includes("<w:tblHeader/>"), false);
});

test("同一行之后连加两行：按提交顺序排列；后一条的锚点不会落到刚加的新行里", () => {
  const r = apply(contract(), [
    op("a", "第二期", "第三期｜升级服务费｜质保期满｜66,000", { insertRowAfter: true }),
    op("b", "第二期", "第四期｜运维服务费｜首年届满｜600,000", { insertRowAfter: true }),
  ]);
  const t = texts(sanitizeDocx(r.docx).docx);
  assert.ok(t.indexOf("第三期") > t.indexOf("第二期") && t.indexOf("第四期") > t.indexOf("第三期") && t.indexOf("合计") > t.indexOf("第四期"));
});

test("删除表格一行：文字与行标记标为删除；接受修订后整行消失，其余行不动", () => {
  const r = apply(contract(), [op("a", "二级", "", { deleteRow: true, comment: "按律师意见删除二级故障一行" })]);
  assert.equal(r.applied[0]!.placement, "row_deleted");
  const xml = docXml(r.docx);
  assertWellFormed(xml, "word/document.xml");
  const row = enclosingElement(xml, "tr", xml.indexOf("二级"), "inner")!;
  const rowXml = xml.slice(row.start, row.end);
  assert.match(rowXml, /<w:trPr><w:del [^>]*\/><\/w:trPr>/);
  assert.equal((rowXml.match(/<w:delText/g) ?? []).length, 4, "四格文字都标为删除");
  assert.equal(/<w:t[ >]/.test(rowXml), false);
  const clean = sanitizeDocx(r.docx).docx;
  const t = texts(clean);
  assert.equal(t.includes("二级"), false);
  assert.equal(t.includes("24小时"), false);
  assert.ok(t.includes("一级") && t.includes("5,000"));
  assert.deepEqual(docxListLabels(clean).filter(Boolean), ["第一条", "1.1", "1.2", "第二条", "2.1", "2.2", "第三条", "3.1"], "条款编号不受影响");
});

test("删除纵向合并组的起始行：类别栏的字不标删除，接受修订后移到下一行；整张表删空则表格一并移除", () => {
  const r = apply(contract(), [op("a", "甲方项目负责人", "", { deleteRow: true })]);
  const xml = docXml(r.docx);
  const row = enclosingElement(xml, "tr", xml.indexOf("甲方项目负责人"), "inner")!;
  assert.match(xml.slice(row.start, row.end), /<w:t xml:space="preserve">联系人<\/w:t>/, "合并格里的类别名不标删除");
  const cleanXml = docXml(sanitizeDocx(r.docx).docx);
  assert.equal(cleanXml.includes("甲方项目负责人"), false);
  const next = enclosingElement(cleanXml, "tr", cleanXml.indexOf("甲方运维对接人"), "inner")!;
  const nextXml = cleanXml.slice(next.start, next.end);
  assert.match(nextXml, /<w:vMerge w:val="restart"\/>/, "下一行成为合并组的起始行");
  assert.ok(nextXml.includes("联系人"), "类别名移到下一行");
  // 整张表删空
  const all = apply(contract(), [op("a", "故障等级", "", { deleteRow: true }), op("b", "一级", "", { deleteRow: true }), op("c", "二级", "", { deleteRow: true })]);
  const gone = docXml(sanitizeDocx(all.docx).docx);
  assertWellFormed(gone, "word/document.xml");
  assert.equal(gone.includes("故障等级"), false);
  assert.equal((gone.match(/<w:tbl>/g) ?? []).length, 2, "三张表剩两张");
  assert.deepEqual(removeDeletedRows("<w:body><w:p/></w:body>"), { xml: "<w:body><w:p/></w:body>", removed: 0 });
});

test("删除表格行：新文字不为空、行里已有他人修订的拒绝", () => {
  assert.throws(() => apply(contract(), [op("a", "二级", "三级", { deleteRow: true })]), /新文字须为空/);
  const withRev = withBody(tbl([tr([tc("甲"), `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:ins w:id="5" w:author="对方" w:date="2026-11-05T00:00:00Z"><w:r><w:t>对方加的字</w:t></w:r></w:ins></w:p></w:tc>`])]) + para("尾"));
  assert.throws(() => apply(withRev, [op("a", "甲", "", { deleteRow: true })]), /原件已有的修订痕迹/);
});

test("列名按网格列取：合计行前三格横向合并，“合计｜金额（元）”能唯一定位到合计金额那一格", () => {
  const docx = contract();
  const cells = paragraphCells(docXml(docx));
  const paras = extractParagraphs(docx);
  const i = paras.findIndex((p) => p.text === "594,000");
  assert.equal(cells[i]!.header, "金额（元）", "第 2 个单元格在第 4 列");
  // 两处“594,000”时靠“合计｜金额（元）”区分
  const two = withBody(tbl([tr([tc("期次"), tc("费用类别"), tc("付款节点"), tc("金额（元）")]), tr([tc("第一期"), tc("升级服务费"), tc("合同生效"), tc("594,000")]), tr([tc("合计", '<w:gridSpan w:val="3"/>'), tc("594,000")])]) + para("尾"));
  const r = apply(two, [op("a", "594,000", "654,000", { anchor: { originalText: "594,000", paragraphHint: "合计｜金额（元）" } })]);
  const t = texts(sanitizeDocx(r.docx).docx);
  assert.deepEqual(t.filter((x) => /,000$/.test(x)), ["594,000", "654,000"], "只改合计那一格");
});

test("逐处改动：整段作锚点只改三个数时，修订稿里是三处各自的删与增；加粗只留在原来加粗的金额上", () => {
  const before = "本合同服务费总额为人民币1,860,000元（大写：壹佰捌拾陆万元整），含增值税，其中运维服务费人民币1,200,000元、升级服务费人民币660,000元。";
  const after = "本合同服务费总额为人民币1,920,000元（大写：壹佰玖拾贰万元整），含增值税，其中运维服务费人民币1,200,000元、升级服务费人民币720,000元。";
  assert.deepEqual(changeHunks(before, after).map((h) => [before.slice(h.a0, h.a1), h.added]), [["1,860,000", "1,920,000"], ["壹佰捌拾陆", "壹佰玖拾贰"], ["660,000", "720,000"]]);
  // 原件：金额“人民币1,860,000元”加粗，其余不加粗（三个 run）
  const body = `<w:p><w:r><w:t xml:space="preserve">本合同服务费总额为</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">人民币1,860,000元</w:t></w:r><w:r><w:t xml:space="preserve">（大写：壹佰捌拾陆万元整），含增值税，其中运维服务费人民币1,200,000元、升级服务费人民币660,000元。</w:t></w:r></w:p>`;
  const docx = withBody(body);
  const r = apply(docx, [op("a", before, after, { comment: "升级服务费调整" })]);
  const xml = docXml(r.docx);
  assertWellFormed(xml, "word/document.xml");
  const dels = [...xml.matchAll(/<w:delText[^>]*>([^<]*)<\/w:delText>/g)].map((m) => m[1]);
  assert.deepEqual(dels, ["1,860,000", "壹佰捌拾陆", "660,000"], "只有三处删除，中间没变的字不动");
  const ins = [...xml.matchAll(/<w:ins\b[^>]*><w:r>(<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t xml:space="preserve">([^<]*)<\/w:t><\/w:r><\/w:ins>/g)].map((m) => [m[2], /<w:b\/>/.test(m[1] ?? "")]);
  assert.deepEqual(ins, [["1,920,000", true], ["壹佰玖拾贰", false], ["720,000", false]], "新数字各自沿用所在位置的格式：只有总额那一处加粗");
  assert.equal((xml.match(/<w:commentRangeStart/g) ?? []).length, 1);
  assert.equal((xml.match(/<w:commentRangeEnd/g) ?? []).length, 1);
  assert.ok(xml.indexOf("<w:commentRangeStart") < xml.indexOf("1,860,000") && xml.indexOf("<w:commentRangeEnd") > xml.indexOf("720,000"), "批注范围罩住第一处到最后一处");
  assert.equal(texts(sanitizeDocx(r.docx).docx).includes(after), true, "接受全部修订后是新文字");
  // 拒绝全部修订（去掉插入、保留删除的字）回到原文
  const rejected = xml.replace(/<w:ins\b[^>]*>[\s\S]*?<\/w:ins>/g, "").replace(/<w:delText/g, "<w:t").replace(/<\/w:delText>/g, "</w:t>");
  assert.ok(rejected.replace(/<[^>]+>/g, "").includes(before));
});

test("逐处改动：整句重写（不变的字不到六成）或改动太碎时仍按一处处理；挨得近的并成一处", () => {
  assert.equal(changeHunks("甲方应于验收合格后三十日内付款。", "乙方开具发票并经甲方确认后，甲方在十五个工作日内付清全部款项。").length, 1);
  assert.deepEqual(changeHunks("三日内完成验收；逾期未提出书面异议的，视为验收合格", "十五个工作日内完成验收，验收以甲方书面确认为准").length, 1);
  assert.deepEqual(changeHunks("乙方应提前15日书面通知甲方", "乙方应提前30日书面通知甲方").map((h) => h.added), ["30"]);
  assert.equal(changeHunks("相同", "相同").length, 1);
  assert.deepEqual(changeHunks("整段删除", ""), [{ a0: 0, a1: 4, added: "" }]);
});
