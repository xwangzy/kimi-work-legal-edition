/**
 * V41 第 67 批工作线 E：Excel 预览按原文排（真实截图：证据目录.xlsx 的“证据编号”被挤成一字一行）。
 * 根因：renderXlsxHtml 不读列宽、行高、合并、样式与数字格式，表名按 sheetN 文件编号对应；界面又给表格套了衬线 16px 的文书纸面，
 * 表格没有列宽、被隔离框架的宽度压扁。用例用手工工作簿（不经本产品写入器）逐项核对。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createXlsx, renderDocxHtml, renderXlsxHtml, writeRawZip, xlsxToText } from "../src/index.ts";
import { formatNumber, generalNumber } from "../src/render-html.ts";
import { complexWorkbook } from "./fixtures/xlsx-complex.ts";

const r = renderXlsxHtml(complexWorkbook());
const sections = [...r.html.matchAll(/<section class="kwl-sheet" data-sheet-name="([^"]*)">([\s\S]*?)<\/section>/g)].map((m) => ({ name: m[1]!, html: m[2]! }));
const sheet = (name: string) => sections.find((s) => s.name === name)!.html;
const rowOf = (html: string, n: number) => new RegExp(`<tr[^>]*><th class="kwl-rh"[^>]*>${n}</th>([\\s\\S]*?)</tr>`).exec(html)?.[1];

test("表名与顺序按工作簿表签（经关系 r:id 对应表文件），不按 sheetN 文件编号；隐藏的工作表不显示并如实说明", () => {
  assert.deepEqual(sections.map((s) => s.name), ["证据目录", "计算明细", "说明"]);
  assert.deepEqual(r.sheetNames, ["证据目录", "计算明细", "说明"]);
  assert.equal(r.sheets, 3);
  assert.equal(r.hiddenSheets, 1);
  // 证据目录在 sheet3.xml：按文件编号会把“计算明细”的内容挂在“证据目录”名下
  assert.match(sheet("证据目录"), /借款合同/);
  assert.match(sheet("计算明细"), /借款本金/);
  assert.doesNotMatch(r.html, /隐藏表的内容/);
  assert.match(r.html, /另有 1 张隐藏的工作表未显示/);
});

test("列宽按原文（Excel 宽度 × 7px）、隐藏列不显示、列号跳过隐藏列；表格定宽（table-layout:fixed）不被框架宽度压扁", () => {
  const h = sheet("证据目录");
  const widths = [...(/<colgroup>([\s\S]*?)<\/colgroup>/.exec(h)?.[1] ?? "").matchAll(/width:(\d+)px/g)].map((m) => Number(m[1]));
  assert.deepEqual(widths, [40, 46, 102, 284, 60, 116], "行号列 40px + A、B、C、E、F（D 列隐藏）");
  assert.match(h, /<table class="kwl-grid" style="width:648px">/);
  assert.match(r.html, /table\.kwl-grid\{[^}]*table-layout:fixed/);
  assert.match(h, /<thead><tr><th class="kwl-corner"><\/th><th>A<\/th><th>B<\/th><th>C<\/th><th>E<\/th><th>F<\/th><\/tr><\/thead>/);
  assert.doesNotMatch(h, /不要显示的备注|内部备注/);
});

test("合并单元格：标题行 A1:F1 合成一格（隐藏的 D 列不计入跨列数），被覆盖的格子不再输出", () => {
  const row1 = rowOf(sheet("证据目录"), 1)!;
  assert.equal((row1.match(/<td\b/g) ?? []).length, 1);
  assert.match(row1, /<td class="[^"]*" colspan="5"[^>]*>证据目录（原告提交）<\/td>/);
});

test("行高（customHeight，磅 × 4/3）、隐藏行不显示、行号照原文（跳过隐藏行）；冻结的表头行固定在列号下面", () => {
  const h = sheet("证据目录");
  assert.match(h, /<tr style="height:40px"><th class="kwl-rh"[^>]*>1<\/th>/, "30 磅 = 40px");
  assert.match(h, /<tr style="height:19px"><th class="kwl-rh">3<\/th>/, "缺省行高 14.25 磅 = 19px");
  const c = sheet("计算明细");
  assert.doesNotMatch(c, /隐藏行不显示/);
  assert.equal(rowOf(c, 4), undefined);
  assert.ok(rowOf(c, 5));
  // 冻结 2 行：第 1 行贴在列号下（22px），第 2 行再往下 40px
  assert.match(rowOf(h, 1)!, /class="[^"]*\bkf\b[^"]*"[^>]*style="top:22px"/);
  assert.match(rowOf(h, 2)!, /style="top:62px"/);
  assert.doesNotMatch(rowOf(h, 3)!, /\bkf\b/);
});

test("对齐、换行、缩进、字形、底色（含主题色明暗）、边框（细框与粗下框）走样式类", () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(r.html)![1]!;
  const cls = (name: string) => new RegExp(`\\.kwl-grid td\\.${name}\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  const header = /<td class="(x\d+)[^"]*"[^>]*>证据名称<\/td>/.exec(sheet("证据目录"))![1]!;
  assert.match(cls(header), /font-weight:700/);
  assert.match(cls(header), /color:#ffffff/);
  assert.match(cls(header), /background:#2f5597/, "主题色 accent1 4472C4 调暗 25%");
  assert.match(cls(header), /text-align:center/);
  assert.match(cls(header), /vertical-align:middle/);
  assert.match(cls(header), /white-space:pre-wrap/);
  const purpose = /<td class="(x\d+)[^"]*">证明原、被告之间/.exec(sheet("证据目录"))![1]!;
  assert.match(cls(purpose), /vertical-align:top;white-space:pre-wrap/);
  const indent = /<td class="(x\d+)[^"]*">证明原告多次催要/.exec(sheet("证据目录"))![1]!;
  assert.match(cls(indent), /padding-left:24px/, "缩进 2 级");
  assert.match(css, /td\.b\d+\{border-bottom:2px solid #000000\}/, "标题行粗下框");
  assert.match(css, /border-right:1px solid #999999;border-bottom:1px solid #999999/);
  // 不换行的格子不折行（Excel 里会溢出或被右邻截断）
  assert.match(css, /\.kwl-grid td\{[^}]*white-space:pre;overflow:hidden/);
  assert.match(sheet("说明"), /kwl-nogrid/, "关了网格线的表不画网格线");
});

test("数字格式：货币、千分位两位小数、百分比、中文日期、红色负数、常规（无浮点尾数）、文字型数字", () => {
  const c = sheet("计算明细");
  const e = sheet("证据目录");
  assert.match(c, />¥1,000,000\.00<\/td>/);
  assert.match(e, />¥1,234,567\.89<\/td>/);
  assert.match(e, />¥0\.00<\/td>/);
  assert.match(c, />12\.5%<\/td>/);
  assert.match(c, />2026年11月9日<\/td>/);
  assert.match(c, />0\.3<\/td>/);
  assert.doesNotMatch(c, /0\.30000000000000004/);
  assert.match(c, /style="color:#ff0000">-¥1,000\.00<\/td>/);
  assert.match(e, /class="x3 b2">1-12<\/td>/, "公式文字照原样、靠左");
  assert.match(c, /class="kn[^"]*">¥1,000,000\.00/, "常规对齐的数字靠右");
});

test("长文字不换行时溢到右边连着的空格子，已用范围不够就补空列（不在表格边上截成一半）", () => {
  const c = sheet("计算明细");
  const row8 = rowOf(c, 8)!;
  const span = Number(/^<td colspan="(\d+)">注：以上金额/.exec(row8)?.[1]);
  assert.ok(span >= 4, `溢出跨 ${span} 列`);
  assert.match(c, /<th>D<\/th>/, "补出 D 列");
  // 有内容的格子照常各占一格
  assert.match(rowOf(c, 2)!, /^<td class="x3 b1">借款本金<\/td>/);
});

test("共享字符串：富文本按段保留粗体与颜色，拼音注音不漏进正文；布尔、错误值；文字一律转义", () => {
  const n = sheet("说明");
  assert.match(n, /<span style="font-weight:700;color:#c00000">重点：<\/span>以合同原件为准/);
  assert.doesNotMatch(r.html, /ジュウテン/);
  assert.match(n, />TRUE<\/td>/);
  assert.match(n, />#DIV\/0!<\/td>/);
  assert.match(n, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(r.html, /<script/i);
  // 文字提取（材料导入）同样不带注音
  assert.doesNotMatch(xlsxToText(complexWorkbook()).text, /ジュウテン/);
});

test("输出只含白名单元素与属性，样式里没有任何外部引用", () => {
  const tags = new Set([...r.html.matchAll(/<([a-z0-9]+)\b/g)].map((m) => m[1]!));
  for (const t of tags) assert.ok(["style", "section", "table", "colgroup", "col", "thead", "tbody", "tr", "th", "td", "p", "span"].includes(t), t);
  const attrs = new Set([...r.html.matchAll(/\s([a-z-]+)="/g)].map((m) => m[1]!));
  for (const a of attrs) assert.ok(["class", "style", "colspan", "rowspan", "data-sheet-name"].includes(a), a);
  assert.doesNotMatch(r.html, /url\s*\(|@import|expression\s*\(|javascript:/i);
});

test("表名里的引号与尖括号转义；超过 500 行、40 列如实说明", () => {
  const rows = [Array.from({ length: 45 }, (_, i) => `列${i + 1}`), ...Array.from({ length: 520 }, (_, i) => [i])];
  const big = renderXlsxHtml(createXlsx([{ name: `甲"<乙>`, rows }]));
  assert.match(big.html, /data-sheet-name="甲&quot;&lt;乙&gt;"/);
  assert.equal(big.truncated, true);
  assert.match(big.html, /预览只显示每个表前 500 行、前 40 列/);
  assert.doesNotMatch(big.html, /列41/);
  assert.equal((rowOf(big.html, 1)!.match(/<td\b/g) ?? []).length, 40);
});

test("数字格式单元：常规、千分位、百分比、科学计数、会计格式的零与括号负数、条件段退回常规", () => {
  assert.equal(generalNumber(0.1 + 0.2), "0.3");
  assert.equal(generalNumber(66970), "66970");
  assert.equal(generalNumber(123456789012), "1.23457E+11");
  assert.equal(generalNumber(-0.00001234), "-1.234E-05");
  assert.equal(formatNumber(1234.5, "#,##0.00").text, "1,234.50");
  assert.equal(formatNumber(1.005, "0.00").text, "1.01", "十进制四舍五入");
  assert.equal(formatNumber(0.05, "0%").text, "5%");
  assert.equal(formatNumber(-1234, "#,##0;(#,##0)").text, "(1,234)");
  assert.equal(formatNumber(0, '_-"¥"* #,##0.00_-;-"¥"* #,##0.00_-;_-"¥"* "-"??_-;_-@_-').text, "¥ -");
  assert.equal(formatNumber(1234.5, '_-"¥"* #,##0.00_-;-"¥"* #,##0.00_-;_-"¥"* "-"??_-;_-@_-').text, "¥ 1,234.50");
  assert.equal(formatNumber(12345, "0.00E+00").text, "1.23E+04");
  assert.equal(formatNumber(-5, '"¥"#,##0').text, "-¥5");
  assert.equal(formatNumber(1500, '#,##0"元"').text, "1,500元");
  assert.equal(formatNumber(150, "[>100]0;0.0").text, "150");
});

test("Word 预览：段落对齐与首行缩进取段落样式（沿 basedOn）与直接格式；修订里的旧格式不算", () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const styles = `<w:styles ${W}><w:docDefaults><w:pPrDefault><w:pPr><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Body"><w:basedOn w:val="Normal"/><w:pPr><w:ind w:firstLineChars="200" w:firstLine="640"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Sign"><w:basedOn w:val="Body"/><w:pPr><w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="right"/></w:pPr></w:style></w:styles>`;
  const p = (pPr: string, t: string) => `<w:p><w:pPr>${pPr}</w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const doc = `<w:document ${W}><w:body>${p('<w:pStyle w:val="Body"/>', "正文段落")}${p('<w:pStyle w:val="Sign"/>', "具状人：某某")}${p('<w:pStyle w:val="Body"/><w:jc w:val="center"/><w:pPrChange w:id="9" w:author="甲"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange>', "此致")}</w:body></w:document>`;
  const docx = writeRawZip([
    { name: "word/document.xml", data: Buffer.from(doc, "utf8") },
    { name: "word/styles.xml", data: Buffer.from(styles, "utf8") },
  ]);
  const h = renderDocxHtml(docx).html;
  assert.match(h, /<p style="text-align:justify;text-indent:2em">正文段落<\/p>/);
  assert.match(h, /<p style="text-align:right">具状人：某某<\/p>/);
  assert.match(h, /<p style="text-align:center;text-indent:2em">此致<\/p>/);
});
