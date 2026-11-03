/**
 * V11：Word 修订引擎文档工程压测（四份结构各异的中文合同语料 + LibreOffice 独立核对，见审计报告）里证实的缺陷，逐条一个用例：
 * - F1 锚点落在复杂域（fldChar begin…separate…end，Word 写交叉引用、页码、日期的常用写法）的结果里：原先照写修订，
 *   LibreOffice 打开后看不到这处修订、“接受全部”后与清洁稿不一致（“第三四条”），域一更新修改即失效——与简单域（fldSimple）同样拒写；
 *   纯插入紧挨在域结果之后的，新字写在域外；
 * - F2 第二轮在第一轮自己插入的字上再删改（同一作者）：原先写成“自己的 w:ins 里套自己的 w:del”，LibreOffice 把删除丢掉，
 *   “接受全部”后旧字新字并存（“1,254,500.001,264,500.00”）、整段删除的段落并进下一段——同一作者照 Word 的做法直接在自己的插入里去字，
 *   整段都是自己插入的段落整段去掉；不同作者（对方律师的插入）仍写嵌套删除；
 * - F3 在带分节符的段落（w:sectPr 在段落属性里，Word 与 LibreOffice 都这样写）之后插入：新段落落到下一节（横向附件页）——分节符移到新段落末尾，
 *   锚点段落的段落标记记为插入（拒绝修订即恢复原样）；
 * - F4 段落标记上的修订（w:pPr/w:rPr 里的 w:del、w:ins）按 CT_ParaRPr 的次序写在 rPr 最前面（原先追加在字体、字号之后）；
 * - F5 修订稿打开“修订”开关时 w:trackRevisions 按 CT_Settings 的次序写（原先写成 settings 的第一个子元素，排在 w:zoom 之前）；
 *   原件写着 w:trackRevisions w:val="false" 的也打开；
 * - F6 表格列名按网格列算（横向合并的“合计”格 gridSpan=5 之后，金额格原先认成第 2 列“设备名称”）：“合计｜金额（元）”这类提示能定位；
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "@zr-legal/domain";
import { applyRevisionsToDocx, createDocx, extractParagraphs, paragraphCells, readZipEntries, sanitizeDocx, writeZip } from "../src/index.ts";

const AI = "Kimi Work 法律助手（AI 建议，待律师确认）";
function withBody(body: string, extra: Record<string, string> = {}): Buffer {
  const files = readZipEntries(createDocx("合同", [{ heading: "占位", paragraphs: ["占位"] }]));
  files.set("word/document.xml", Buffer.from(files.get("word/document.xml")!.toString("utf8").replace(/<w:body>[\s\S]*?(<w:sectPr)/, `<w:body>${body}$1`)));
  for (const [k, v] of Object.entries(extra)) files.set(k, Buffer.from(v));
  return writeZip([...files.entries()].map(([name, data]) => ({ name, data })));
}
const docXml = (docx: Buffer) => readZipEntries(docx).get("word/document.xml")!.toString("utf8");
type Op = { a: string; n: string; hint?: string; ins?: boolean; author?: string };
const revise = (docx: Buffer, ops: Op[]) =>
  applyRevisionsToDocx(docx, {
    baselineHash: sha256Hex(docx),
    ops: ops.map((o, i) => ({ opId: `p${i}`, anchor: { originalText: o.a, ...(o.hint ? { paragraphHint: o.hint } : {}) }, originalHash: sha256Hex(o.a), newText: o.n, author: o.author ?? AI, ...(o.ins ? { insertAfter: true } : {}) })),
  }).docx;
const texts = (docx: Buffer) => extractParagraphs(docx).map((p) => p.text);
const p = (inner: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;
const r = (t: string, rPr = "") => `<w:r>${rPr}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const field = (instr: string, shown: string) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r(shown)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;

/** “拒绝全部修订”后的段落文字（不靠引擎）：插入的字去掉、删除的字恢复；段落标记被插入的段落并入下一段。 */
function rejectAllTexts(xml: string): string[] {
  const out: string[] = [];
  let carry = "";
  for (const m of xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const inner = m[1] ?? "";
    const pPr = /^<w:pPr>[\s\S]*?<\/w:pPr>/.exec(inner)?.[0] ?? "";
    const body = inner.slice(pPr.length).replace(/<w:ins\b[^>]*>[\s\S]*?<\/w:ins>/g, "");
    const t = [...body.matchAll(/<w:(?:t|delText)\b[^>]*>([^<]*)<\/w:(?:t|delText)>/g)].map((x) => x[1]).join("");
    if (/<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<w:ins\b[^>]*\/>/.test(pPr)) carry += t;
    else {
      out.push(carry + t);
      carry = "";
    }
  }
  return out;
}

test("F1：锚点在复杂域（REF 交叉引用、DATE）的结果里拒写，说明原因；纯插入紧挨域结果之后的写在域外；同段别处照常可改", () => {
  const docx = withBody([p(`${r("“交割日”指本协议")}${field("REF _Ref501 \\r \\h", "第三条")}${r("约定的全部先决条件满足之日。")}`), p(`${r("签订日期：")}${field('DATE \\@ "yyyy年M月d日"', "2026年10月15日")}`)].join(""));
  assert.deepEqual(texts(docx), ["“交割日”指本协议第三条约定的全部先决条件满足之日。", "签订日期：2026年10月15日"]);
  assert.throws(() => revise(docx, [{ a: "本协议第三条约定", n: "本协议第四条约定" }]), /域/);
  assert.throws(() => revise(docx, [{ a: "2026年10月15日", n: "2026年10月16日" }]), /域/);
  // 插入点在域结果末尾：新字写在域结束之后（不进域结果）
  const ins = docXml(revise(docx, [{ a: "第三条约定的全部", n: "第三条所约定的全部" }]));
  const after = ins.slice(ins.indexOf('w:fldCharType="end"'));
  assert.match(after, /^w:fldCharType="end"\/><\/w:r><w:ins\b[^>]*><w:r><w:t xml:space="preserve">所<\/w:t><\/w:r><\/w:ins>/, "新字在域结束标记之后");
  assert.deepEqual(texts(sanitizeDocx(revise(docx, [{ a: "约定的全部先决条件满足之日", n: "约定的先决条件全部满足之日" }])).docx)[0], "“交割日”指本协议第三条约定的先决条件全部满足之日。");
});

test("F2：第二轮在第一轮自己插入的字上删改（同一作者）：不写自己套自己的删除；接受全部得新文字、拒绝全部回到原件；整段删去自己插入的段落", () => {
  const original = withBody([p(r("合计金额为1,234,500.00元。")), p(r("2.1 乙方应负责安装调试。")), p(r("2.2 甲方组织验收。"))].join(""));
  const r1 = revise(original, [
    { a: "1,234,500.00", n: "1,254,500.00" },
    { a: "乙方应负责安装调试。", n: "乙方应同时提供操作培训。", ins: true },
  ]);
  assert.deepEqual(texts(sanitizeDocx(r1).docx), ["合计金额为1,254,500.00元。", "2.1 乙方应负责安装调试。", "乙方应同时提供操作培训。", "2.2 甲方组织验收。"]);
  // 律师回传第一轮修订稿，再改：同一作者
  const r2 = revise(r1, [{ a: "1,254,500.00", n: "1,264,500.00" }, { a: "乙方应同时提供操作培训。", n: "" }]);
  const x2 = docXml(r2);
  for (const m of x2.matchAll(/<w:ins\b[^>]*?w:author="([^"]*)"[^>]*(?<!\/)>((?:(?!<\/w:ins>)[\s\S])*)<\/w:ins>/g)) {
    const inner = m[2]!;
    const del = /<w:del\b[^>]*w:author="([^"]*)"/.exec(inner);
    assert.ok(!del || del[1] !== m[1], `不写同一作者的“插入里套删除”：${m[0].slice(0, 160)}`);
  }
  assert.doesNotMatch(x2, /<w:ins\b[^>]*><\/w:ins>/, "不留空的插入");
  assert.doesNotMatch(x2, /操作培训/, "整段都是自己插入的段落整段去掉");
  assert.deepEqual(texts(sanitizeDocx(r2).docx), ["合计金额为1,264,500.00元。", "2.1 乙方应负责安装调试。", "2.2 甲方组织验收。"]);
  assert.deepEqual(rejectAllTexts(x2), ["合计金额为1,234,500.00元。", "2.1 乙方应负责安装调试。", "2.2 甲方组织验收。"], "拒绝全部回到原件");
  // 不同作者（律师复核时改 AI 的建议）：仍写嵌套删除，保留谁改了谁
  const other = docXml(revise(r1, [{ a: "1,254,500.00", n: "1,264,500.00", author: "律师（复核）" }]));
  assert.match(other, new RegExp(`<w:ins\\b[^>]*w:author="${AI.replace(/[()（）]/g, ".")}"[^>]*><w:del\\b[^>]*w:author="律师（复核）"`), "他人的插入里写嵌套删除");
});

test("F3：在带分节符的段落之后插入：新段落仍在本节（分节符移到新段落），锚点段落的段落标记记为插入；接受 / 拒绝都还原结构", () => {
  const sect = `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>`;
  const docx = withBody([p(r("第九条 本合同自双方签字盖章之日起生效。")), p(r("甲方（盖章）：乙方（盖章）："), `<w:jc w:val="left"/><w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr>${sect}`), p(r("附件：交接清单"))].join(""));
  const rev = revise(docx, [{ a: "乙方（盖章）：", n: "签订日期：2026年12月1日\n签订地点：深圳", ins: true }]);
  const xml = docXml(rev);
  const paras = [...xml.matchAll(/<w:p\b[^>]*?(?:\/>|>[\s\S]*?<\/w:p>)/g)].map((m) => m[0]);
  const at = paras.findIndex((x) => x.includes("乙方（盖章）"));
  assert.doesNotMatch(paras[at]!, /<w:sectPr\b/, "锚点段落不再带分节符");
  assert.match(paras[at]!, /<w:pPr>[\s\S]*<w:rPr><w:ins\b[^>]*\/><w:rFonts w:hint="eastAsia"\/><\/w:rPr>[\s\S]*<\/w:pPr>/, "锚点段落的段落标记记为插入（写在 rPr 最前）");
  assert.match(paras[at + 1]!, /签订日期/);
  assert.match(paras[at + 1]!, /<w:rPr><w:ins\b[^>]*\/><\/w:rPr>/);
  assert.match(paras[at + 2]!, /签订地点/);
  assert.match(paras[at + 2]!, /<w:sectPr\b/, "分节符在最后一个新段落上");
  assert.doesNotMatch(/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(paras[at + 2]!)![0], /<w:ins\b/, "最后一段的段落标记是原来的那个（不记插入）");
  assert.match(paras[at + 3]!, /附件/);
  // 接受全部：分节符跟着本节最后一段（新段落）
  const clean = docXml(sanitizeDocx(rev).docx);
  const cp = [...clean.matchAll(/<w:p\b[^>]*?(?:\/>|>[\s\S]*?<\/w:p>)/g)].map((m) => m[0]);
  const ci = cp.findIndex((x) => x.includes("签订地点"));
  assert.match(cp[ci]!, /<w:sectPr\b/);
  assert.doesNotMatch(cp[ci - 2]!, /<w:sectPr\b/);
  assert.match(cp[ci + 1]!, /附件/);
  // 拒绝全部：回到原件的三段
  assert.deepEqual(rejectAllTexts(xml).slice(0, 3), ["第九条 本合同自双方签字盖章之日起生效。", "甲方（盖章）：乙方（盖章）：", "附件：交接清单"]);
  // 同一段之后再插一条：分节符继续跟到最后
  const rev2 = docXml(revise(docx, [{ a: "乙方（盖章）：", n: "签订日期：2026年12月1日", ins: true }, { a: "乙方（盖章）：", n: "签订地点：深圳", ins: true }]));
  const p2 = [...rev2.matchAll(/<w:p\b[^>]*?(?:\/>|>[\s\S]*?<\/w:p>)/g)].map((m) => m[0]);
  const j = p2.findIndex((x) => x.includes("签订地点"));
  assert.equal(p2.filter((x) => /<w:sectPr\b/.test(x) && !/<w:body>/.test(x)).length, 1, "只有一个段落带这个分节符");
  assert.match(p2[j]!, /<w:sectPr\b/);
  assert.match(p2[j - 1]!, /签订日期/);
  assert.match(/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(p2[j - 1]!)![0], /<w:ins\b/);
});

test("F4：段落标记上的删除写在 w:pPr/w:rPr 的最前面（CT_ParaRPr：ins、del 在字体字号之前）", () => {
  const docx = withBody([p(r("5.1 第一款。")), p(r("5.2 本款整段删除。"), `<w:jc w:val="both"/><w:rPr><w:rFonts w:hint="eastAsia"/><w:sz w:val="28"/></w:rPr>`), p(r("5.3 第三款。"))].join(""));
  const xml = docXml(revise(docx, [{ a: "5.2 本款整段删除。", n: "" }]));
  assert.match(xml, /<w:pPr><w:jc w:val="both"\/><w:rPr><w:del w:id="\d+" w:author="[^"]+" w:date="[^"]+"\/><w:rFonts w:hint="eastAsia"\/><w:sz w:val="28"\/><\/w:rPr><\/w:pPr>/);
  // 段落标记已是对方插入的：del 接在 ins 之后
  const theirs = withBody([p(r("甲。")), p(`<w:ins w:id="70" w:author="对方律师" w:date="2026-10-01T00:00:00Z">${r("对方加的一款。")}</w:ins>`, `<w:rPr><w:ins w:id="71" w:author="对方律师" w:date="2026-10-01T00:00:00Z"/><w:b/></w:rPr>`), p(r("乙。"))].join(""));
  const x2 = docXml(revise(theirs, [{ a: "对方加的一款。", n: "" }]));
  assert.match(x2, /<w:rPr><w:ins w:id="71" w:author="对方律师" w:date="2026-10-01T00:00:00Z"\/><w:del w:id="\d+"[^>]*\/><w:b\/><\/w:rPr>/);
  assert.deepEqual(texts(sanitizeDocx(revise(theirs, [{ a: "对方加的一款。", n: "" }])).docx), ["甲。", "乙。"]);
});

test("F5：修订稿打开“修订”开关时 w:trackRevisions 按 CT_Settings 的次序写在 w:zoom、w:proofState 之后；原件写 false 的改为打开", () => {
  const settings = (inner: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${inner}</w:settings>`;
  const base = `<w:zoom w:percent="100"/><w:bordersDoNotSurroundHeader/><w:proofState w:spelling="clean" w:grammar="clean"/><w:defaultTabStop w:val="420"/><w:characterSpacingControl w:val="compressPunctuation"/>`;
  const docx = withBody(p(r("甲方应付款。")), { "word/settings.xml": settings(base) });
  const out = readZipEntries(revise(docx, [{ a: "付款", n: "按期付款" }])).get("word/settings.xml")!.toString("utf8");
  assert.match(out, /<w:proofState w:spelling="clean" w:grammar="clean"\/><w:trackRevisions\/><w:defaultTabStop w:val="420"\/>/);
  const off = withBody(p(r("甲方应付款。")), { "word/settings.xml": settings(`<w:zoom w:percent="100"/><w:trackRevisions w:val="false"/><w:defaultTabStop w:val="420"/>`) });
  const out2 = readZipEntries(revise(off, [{ a: "付款", n: "按期付款" }])).get("word/settings.xml")!.toString("utf8");
  assert.match(out2, /<w:zoom w:percent="100"\/><w:trackRevisions\/><w:defaultTabStop w:val="420"\/>/);
  // 排在前面的元素（含带子元素的 w:activeWritingStyle 之类）之后、排在后面的 w:doNotTrackMoves 之前
  const only = withBody(p(r("甲方应付款。")), { "word/settings.xml": settings(`<w:view w:val="print"/><w:hideSpellingErrors/><w:doNotTrackMoves/>`) });
  assert.match(readZipEntries(revise(only, [{ a: "付款", n: "按期付款" }])).get("word/settings.xml")!.toString("utf8"), /<w:hideSpellingErrors\/><w:trackRevisions\/><w:doNotTrackMoves\/><\/w:settings>/);
  const none = withBody(p(r("甲方应付款。")), { "word/settings.xml": settings(`<w:defaultTabStop w:val="420"/>`) });
  assert.match(readZipEntries(revise(none, [{ a: "付款", n: "按期付款" }])).get("word/settings.xml")!.toString("utf8"), /<w:settings [^>]*><w:trackRevisions\/><w:defaultTabStop w:val="420"\/>/);
  // 清洁稿关掉
  assert.doesNotMatch(readZipEntries(sanitizeDocx(revise(docx, [{ a: "付款", n: "按期付款" }])).docx).get("word/settings.xml")!.toString("utf8"), /trackRevisions/);
});

test("F6：横向合并（gridSpan）之后的格子按网格列认列名：“合计｜金额（元）”能定位，位置说明不再写成“设备名称”", () => {
  const tc = (t: string, span = 1) => `<w:tc><w:tcPr>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}</w:tcPr>${p(r(t))}</w:tc>`;
  const table = `<w:tbl><w:tblGrid><w:gridCol w:w="800"/><w:gridCol w:w="2000"/><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/></w:tblGrid>` +
    `<w:tr>${tc("序号")}${tc("设备名称")}${tc("单价（元）")}${tc("金额（元）")}</w:tr>` +
    `<w:tr>${tc("1")}${tc("数控车床")}${tc("624,000.00")}${tc("624,000.00")}</w:tr>` +
    `<w:tr>${tc("合计", 3)}${tc("624,000.00")}</w:tr></w:tbl>`;
  const docx = withBody(p(r("1.1 设备清单如下：")) + table + p(r("1.2 其他。")));
  const cells = paragraphCells(docXml(docx));
  const total = cells.find((c) => c && c.row === 3 && c.col === 2)!;
  assert.equal(total.header, "金额（元）", "合计行的金额格是“金额（元）”列");
  const clean = sanitizeDocx(revise(docx, [{ a: "624,000.00", n: "644,000.00", hint: "合计｜金额（元）" }])).docx;
  assert.deepEqual(texts(clean).slice(9, 11), ["合计", "644,000.00"]);
  assert.equal(texts(clean).filter((t) => t === "624,000.00").length, 2, "同值的单价、金额格不动");
  // 同一行里有列名区分：数控车床行的“金额（元）”
  const c2 = sanitizeDocx(revise(docx, [{ a: "624,000.00", n: "600,000.00", hint: "数控车床｜金额（元）" }])).docx;
  assert.deepEqual(texts(c2).slice(5, 9), ["1", "数控车床", "624,000.00", "600,000.00"]);
});
