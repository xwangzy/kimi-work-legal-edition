/**
 * V41 第 67 批 Excel 预览用例的手工工作簿（不经本产品的写入器，模拟律师从 Excel / WPS 带来的表）：
 * - 三张可见表 + 一张隐藏表；workbook.xml 的表签顺序（证据目录、计算明细、说明）与文件编号（sheet3、sheet1、sheet2）不同，经关系 r:id 对应；
 * - 合并的标题行、宽窄不一的列、隐藏列、隐藏行、自动换行、居中与缩进、主题色底色、细框与粗下框；
 * - 货币、百分比、千分位两位小数、中文日期、红色负数、浮点尾数（0.1+0.2）、长文字溢到右侧空格；
 * - 共享字符串里的富文本与拼音注音（<rPh> 不能漏进正文）、布尔、错误值、内联字符串；冻结首行。
 * 带 [Content_Types].xml 与包关系，可直接用 Excel / WPS 打开对照。
 */
import { writeRawZip } from "../../src/index.ts";

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const SHARED = [
  "证据目录（原告提交）", // 0
  "序号", // 1
  "证据名称", // 2
  "证明目的", // 3
  "内部备注（隐藏列）", // 4
  "页码", // 5
  "金额", // 6
  "借款合同", // 7
  "证明原、被告之间存在借款合同关系，约定借款本金 100 万元、年利率 6%，借款期限自 2025 年 1 月 1 日起至 2025 年 12 月 31 日止。", // 8
  "不要显示的备注", // 9
  "转账凭证", // 10
  "证明原告已按约定全额出借款项。", // 11
  "催款函及快递签收记录", // 12
  "证明原告多次催要，被告至今未还。", // 13
];

const sst = () => {
  const items = SHARED.map((s) => `<si><t xml:space="preserve">${x(s)}</t></si>`);
  // 富文本 + 拼音注音（第 14 项）
  items.push(`<si><r><rPr><b/><sz val="11"/><color rgb="FFC00000"/><rFont val="等线"/></rPr><t>重点：</t></r><r><rPr><sz val="11"/><rFont val="等线"/></rPr><t>以合同原件为准</t></r><rPh sb="0" eb="2"><t>ジュウテン</t></rPh><phoneticPr fontId="1"/></si>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst ${NS} count="${items.length}" uniqueCount="${items.length}">${items.join("")}</sst>`;
};

const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${NS}>
<numFmts count="4"><numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/><numFmt numFmtId="167" formatCode="[$¥-804]#,##0.00;[Red]\\-[$¥-804]#,##0.00"/></numFmts>
<fonts count="4"><font><sz val="11"/><color theme="1"/><name val="等线"/><family val="2"/><charset val="134"/><scheme val="minor"/></font><font><b/><sz val="16"/><color theme="1"/><name val="等线"/></font><font><b/><sz val="11"/><color theme="0"/><name val="等线"/></font><font><i/><sz val="11"/><color rgb="FFFF0000"/><name val="等线"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4" tint="-0.249977111117893"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF999999"/></left><right style="thin"><color rgb="FF999999"/></right><top style="thin"><color rgb="FF999999"/></top><bottom style="thin"><color rgb="FF999999"/></bottom><diagonal/></border><border><left/><right/><top/><bottom style="medium"><color auto="1"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="165" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" indent="2"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const s = (r: string, idx: number, st: number) => `<c r="${r}" s="${st}" t="s"><v>${idx}</v></c>`;
const n = (r: string, v: number | string, st: number) => `<c r="${r}" s="${st}"><v>${v}</v></c>`;
const sheet = (body: string, extra = { before: "", after: "" }) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}>${extra.before}<sheetData>${body}</sheetData>${extra.after}</worksheet>`;

/** 证据目录（文件 sheet3.xml，表签第 1 张）：合并标题、列宽、隐藏 D 列、换行。 */
const evidence = sheet(
  [
    `<row r="1" ht="30" customHeight="1">${s("A1", 0, 1)}${n("B1", "", 1).replace("<v></v>", "")}<c r="C1" s="1"/><c r="D1" s="1"/><c r="E1" s="1"/><c r="F1" s="1"/></row>`,
    `<row r="2" ht="20" customHeight="1">${s("A2", 1, 2)}${s("B2", 2, 2)}${s("C2", 3, 2)}${s("D2", 4, 2)}${s("E2", 5, 2)}${s("F2", 6, 2)}</row>`,
    `<row r="3">${n("A3", 1, 11)}${s("B3", 7, 3)}${s("C3", 8, 3)}${s("D3", 9, 3)}${n("E3", "1-12", 3).replace("<v>1-12</v>", "<v>1-12</v>").replace('s="3">', 's="3" t="str">')}${n("F3", 1000000, 4)}</row>`,
    `<row r="4">${n("A4", 2, 11)}${s("B4", 10, 3)}${s("C4", 11, 3)}<c r="D4" s="3"/>${n("E4", 13, 3)}${n("F4", 1234567.891, 4)}</row>`,
    `<row r="5">${n("A5", 3, 11)}${s("B5", 12, 3)}${s("C5", 13, 10)}<c r="D5" s="3"/>${n("E5", 20, 3)}${n("F5", 0, 4)}</row>`,
  ].join(""),
  {
    before: `<sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="14.25"/><cols><col min="1" max="1" width="6.625" customWidth="1"/><col min="2" max="2" width="14.625" customWidth="1"/><col min="3" max="3" width="40.625" customWidth="1"/><col min="4" max="4" width="20" hidden="1" customWidth="1"/><col min="5" max="5" width="8.625" customWidth="1"/><col min="6" max="6" width="16.625" customWidth="1"/></cols>`,
    after: `<mergeCells count="1"><mergeCell ref="A1:F1"/></mergeCells>`,
  },
);

/** 计算明细（文件 sheet1.xml，表签第 2 张）：数字格式、隐藏第 4 行、溢出文字。 */
const calc = sheet(
  [
    `<row r="1">${`<c r="A1" s="2" t="inlineStr"><is><t>项目</t></is></c>`}${`<c r="B1" s="2" t="inlineStr"><is><t>数值</t></is></c>`}${`<c r="C1" s="2" t="inlineStr"><is><t>说明</t></is></c>`}</row>`,
    `<row r="2"><c r="A2" s="3" t="inlineStr"><is><t>借款本金</t></is></c>${n("B2", 1000000, 4)}<c r="C2" s="3" t="inlineStr"><is><t>货币格式</t></is></c></row>`,
    `<row r="3"><c r="A3" s="3" t="inlineStr"><is><t>年利率</t></is></c>${n("B3", 0.125, 5)}<c r="C3" s="3" t="inlineStr"><is><t>百分比</t></is></c></row>`,
    `<row r="4" hidden="1"><c r="A4" s="3" t="inlineStr"><is><t>隐藏行不显示</t></is></c>${n("B4", 99, 0)}</row>`,
    `<row r="5"><c r="A5" s="3" t="inlineStr"><is><t>起算日</t></is></c>${n("B5", 46335, 6)}<c r="C5" s="3" t="inlineStr"><is><t>中文日期</t></is></c></row>`,
    `<row r="6"><c r="A6" s="3" t="inlineStr"><is><t>小计</t></is></c>${n("B6", 0.30000000000000004, 0)}<c r="C6" s="3" t="inlineStr"><is><t>常规</t></is></c></row>`,
    `<row r="7"><c r="A7" s="3" t="inlineStr"><is><t>已还</t></is></c>${n("B7", -1000, 8)}<c r="C7" s="3" t="inlineStr"><is><t>红色负数</t></is></c></row>`,
    `<row r="8"><c r="A8" s="0" t="inlineStr"><is><t>注：以上金额按合同约定计算至实际清偿之日止，最终以法院认定为准。</t></is></c></row>`,
  ].join(""),
  { before: `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="12.625" customWidth="1"/><col min="2" max="2" width="18.625" customWidth="1"/><col min="3" max="3" width="12.625" customWidth="1"/></cols>`, after: "" },
);

/** 说明（文件 sheet2.xml，表签第 3 张）：富文本、拼音注音、布尔、错误值。 */
const notes = sheet(
  [`<row r="1">${s("A1", 14, 0)}</row>`, `<row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2" t="e"><v>#DIV/0!</v></c><c r="C2" s="9" t="inlineStr"><is><t>&lt;script&gt;alert(1)&lt;/script&gt;</t></is></c></row>`].join(""),
  { before: `<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><cols><col min="1" max="3" width="20" customWidth="1"/></cols>`, after: "" },
);

const hiddenSheet = sheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>隐藏表的内容</t></is></c></row>`);

export function complexWorkbook(): Buffer {
  const files: [string, string][] = [
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${[1, 2, 3, 4].map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    ],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${NS}><sheets><sheet name="证据目录" sheetId="3" r:id="rId3"/><sheet name="计算明细" sheetId="1" r:id="rId1"/><sheet name="说明" sheetId="2" r:id="rId2"/><sheet name="底稿" sheetId="4" state="hidden" r:id="rId4"/></sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[1, 2, 3, 4].map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join("")}<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ],
    ["xl/styles.xml", styles],
    ["xl/sharedStrings.xml", sst()],
    ["xl/worksheets/sheet1.xml", calc],
    ["xl/worksheets/sheet2.xml", notes],
    ["xl/worksheets/sheet3.xml", evidence],
    ["xl/worksheets/sheet4.xml", hiddenSheet],
  ];
  return writeRawZip(files.map(([name, data]) => ({ name, data: Buffer.from(data, "utf8") })));
}
