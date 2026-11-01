/**
 * 第 34 批：Word 修订引擎格式保真（文档工程子代理压测 21 条，逐条回查源码后修复的部分；编号 B34-Dxx 见第 34 批主文）。
 * - D05 自闭合空段落 <w:p …/> 单独成段（原先与下一段并成一段，整段删除写出非法结构）；
 * - D07 同一 run 里制表符、换行之后的文字也能定位，改前半段不丢后半段；D19 替换文字里的换行写成 w:br；
 * - D08 没改的字保留各自原来的格式；D03 他人格式修订（w:rPrChange）的 run 能改且不写坏文件；
 * - D10 条款提示对不上时拒写（不再改第一处），表格格子按所在行认提示；D11 同段第二处修改不落到第一处新插入的字上；
 * - D01/D06/D09 跨他人修订、锚点里有脚注引用时拒写并说明；D12 清洁稿去掉移动修订、格式修订记录与脚注里的修订；D14 数字字符引用解码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "@zr-legal/domain";
import { applyRevisionsToDocx, createDocx, docxListLabels, extractParagraphs, mapParagraphs, pickByHint, readZipEntries, sanitizeDocx, writeZip } from "../src/index.ts";

function withBody(body: string, extra: Record<string, string> = {}): Buffer {
  const files = readZipEntries(createDocx("合同", [{ heading: "占位", paragraphs: ["占位"] }]));
  files.set("word/document.xml", Buffer.from(files.get("word/document.xml")!.toString("utf8").replace(/<w:body>[\s\S]*?(<w:sectPr)/, `<w:body>${body}$1`)));
  for (const [k, v] of Object.entries(extra)) files.set(k, Buffer.from(v));
  return writeZip([...files.entries()].map(([name, data]) => ({ name, data })));
}
const docXml = (docx: Buffer) => readZipEntries(docx).get("word/document.xml")!.toString("utf8");
type Op = { a: string; n: string; hint?: string; ins?: boolean };
const revise = (docx: Buffer, ops: Op[]) =>
  applyRevisionsToDocx(docx, {
    baselineHash: sha256Hex(docx),
    ops: ops.map((o, i) => ({ opId: `p${i}`, anchor: { originalText: o.a, ...(o.hint ? { paragraphHint: o.hint } : {}) }, originalHash: sha256Hex(o.a), newText: o.n, author: "测试", ...(o.ins ? { insertAfter: true } : {}) })),
  }).docx;
const texts = (docx: Buffer) => extractParagraphs(docx).map((p) => p.text);
const p = (inner: string) => `<w:p>${inner}</w:p>`;
const r = (t: string, rPr = "") => `<w:r>${rPr}<w:t xml:space="preserve">${t}</w:t></w:r>`;
/** 标签逐一配对（与引擎写完后的自检同一口径之外再查一遍：用例里不依赖引擎自己的检查） */
function wellFormed(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.replace(/<\?[\s\S]*?\?>/g, "").matchAll(/<(\/?)([A-Za-z_][\w.:-]*)\b[^>]*?(\/?)>/g)) {
    if (m[3] === "/") continue;
    if (!m[1]) stack.push(m[2]!);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}

test("D05：自闭合空段落单独成段；紧跟其后的条款整段删除，修订稿与清洁稿结构完整、空行保留", () => {
  const docx = withBody([p(r("第一条 总则")), `<w:p w:rsidR="00A1B2C3"/>`, p(r("1.2 本条款紧跟空段落。")), p(r("第二条 其他"))].join(""));
  assert.deepEqual(texts(docx), ["第一条 总则", "", "1.2 本条款紧跟空段落。", "第二条 其他"], "空段落单独算一段");
  const rev = revise(docx, [{ a: "1.2 本条款紧跟空段落。", n: "" }]);
  assert.ok(wellFormed(docXml(rev)));
  assert.match(docXml(rev), /<w:p w:rsidR="00A1B2C3"\/>/, "空段落原样保留");
  const clean = sanitizeDocx(rev).docx;
  assert.ok(wellFormed(docXml(clean)));
  assert.deepEqual(texts(clean), ["第一条 总则", "", "第二条 其他"]);
});

test("D07/D19：同一 run 里制表符后的文字能改，改前半段不丢后半段；替换文字里的换行写成 w:br", () => {
  const sign = `<w:r><w:rPr><w:b/></w:rPr><w:t>甲方（盖章）：</w:t><w:tab/><w:t>乙方（盖章）：</w:t></w:r>`;
  const docx = withBody([p(sign), p(r("地址：北京市朝阳区"))].join(""));
  assert.equal(texts(docx)[0], "甲方（盖章）：\t乙方（盖章）：", "与材料文字视图一致：制表符记作 \\t，第二段文字也在");
  const rev = revise(docx, [{ a: "乙方（盖章）", n: "乙方（签章）" }]);
  const clean = sanitizeDocx(rev).docx;
  assert.equal(texts(clean)[0], "甲方（盖章）：\t乙方（签章）：");
  const rev2 = revise(docx, [{ a: "甲方（盖章）", n: "甲方（签章）" }]);
  assert.equal(texts(sanitizeDocx(rev2).docx)[0], "甲方（签章）：\t乙方（盖章）：", "后半段没丢");
  assert.match(docXml(rev2), /<w:r><w:rPr><w:b\/><\/w:rPr><w:tab\/><\/w:r>/, "制表符照原样保留、格式不变");
  const rev3 = revise(docx, [{ a: "地址：北京市朝阳区", n: "地址：北京市海淀区\n电话：010-12345678" }]);
  assert.match(docXml(rev3), /<w:t xml:space="preserve">海淀区<\/w:t><w:br\/><w:t xml:space="preserve">电话：010-12345678<\/w:t>/);
  assert.doesNotMatch(docXml(rev3), /<w:t[^>]*>[^<]*\n/, "w:t 里没有字面换行");
});

test("D08：没改的字保留各自原来的格式（下划线、字体不被第一个 run 的格式覆盖）", () => {
  const u = `<w:rPr><w:u w:val="single"/><w:rFonts w:eastAsia="楷体"/></w:rPr>`;
  const docx = withBody(p(`${r("甲方应于")}${r("收到发票后十日内", u)}${r("付款。")}`));
  const rev = docXml(revise(docx, [{ a: "于收到发票后十日内付款", n: "于收到发票后三十个工作日内付款" }]));
  assert.match(rev, /<w:r><w:rPr><w:u w:val="single"\/><w:rFonts w:eastAsia="楷体"\/><\/w:rPr><w:t xml:space="preserve">收到发票后<\/w:t><\/w:r>/, "“收到发票后”仍是下划线楷体");
  assert.match(rev, /<w:del [^>]*><w:r><w:rPr><w:u w:val="single"\/>[^]*?<w:delText xml:space="preserve">十<\/w:delText>/, "删除的字带原格式");
  assert.match(rev, /<w:r><w:t xml:space="preserve">付款。<\/w:t><\/w:r>/, "“付款。”没有套用下划线");
});

test("D03：run 带他人格式修订（w:rPrChange）时能改、不写坏文件，新 run 不复制对方的格式修订记录", () => {
  const rPr = `<w:rPr><w:b/><w:rPrChange w:id="90" w:author="对方律师" w:date="2026-10-01T00:00:00Z"><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr>`;
  const docx = withBody(p(r("对方修改了格式的文字。", rPr)));
  const rev = docXml(revise(docx, [{ a: "格式的文字", n: "格式的条款" }]));
  assert.ok(wellFormed(rev));
  // 保留的“对方修改了格式的”“。”与删除的“文字”照原格式（连同对方的格式修订记录）重发，编号各不相同；新插入的“条款”不带
  const ids = [...rev.matchAll(/<w:rPrChange w:id="(\d+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, "编号不重复");
  assert.match(rev, /<w:ins [^>]*><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">条款<\/w:t><\/w:r><\/w:ins>/);
});

test("D10：条款提示对不上时拒写（不再改第一处）；表格格子按同一行的项目名认提示", () => {
  const docx = withBody([p(r("9.1 违约金为合同总价的百分之五。")), p(r("9.2 违约金为合同总价的百分之五。"))].join(""));
  assert.throws(() => revise(docx, [{ a: "违约金为合同总价的百分之五。", n: "违约金为合同总价的百分之十。", hint: "9.9" }]), /条款提示“9\.9”对不上/);
  assert.deepEqual(texts(sanitizeDocx(revise(docx, [{ a: "违约金为合同总价的百分之五。", n: "违约金为合同总价的百分之十。", hint: "9.2" }])).docx), ["9.1 违约金为合同总价的百分之五。", "9.2 违约金为合同总价的百分之十。"]);
  const tc = (t: string) => `<w:tc>${p(r(t))}</w:tc>`;
  const table = `<w:tbl><w:tr>${tc("合计")}${tc("无")}</w:tr><w:tr>${tc("首期")}${tc("无")}</w:tr></w:tbl>`;
  const t2 = withBody(table + p(r("其他")));
  assert.deepEqual(texts(sanitizeDocx(revise(t2, [{ a: "无", n: "已于签约日支付", hint: "首期" }])).docx), ["合计", "无", "首期", "已于签约日支付", "其他"]);
  assert.equal(pickByHint([{ label: "3.2", text: "甲方" }, { label: "3.2.1", text: "乙方" }], "3.2"), 0);
  assert.equal(pickByHint([{ label: null, text: "3.2 甲方" }, { label: null, text: "3.2.1 乙方" }], "3.2"), 0, "段首是 3.2.1 的不算 3.2");
});

test("D11：同一段两处修改，第二处的原文恰好出现在第一处新写的字里，仍改原文所在的位置", () => {
  const docx = withBody(p(r("甲方付款二十日。乙方于三个工作日内交货。")));
  const clean = sanitizeDocx(revise(docx, [{ a: "付款二十日", n: "付款三十个工作日" }, { a: "工作日", n: "自然日" }])).docx;
  assert.deepEqual(texts(clean), ["甲方付款三十个工作日。乙方于三个自然日内交货。"]);
});

test("D01/D06/D09：锚点跨过对方的修订或含脚注引用时整体拒写、说明原因；同段别处照常可改", () => {
  const theirs = `<w:ins w:id="80" w:author="对方律师" w:date="2026-10-01T00:00:00Z">${r("三")}</w:ins>`;
  const docx = withBody(p(`${r("乙方应于交割日后十")}${theirs}${r("日内办理变更登记。")}`));
  assert.throws(() => revise(docx, [{ a: "交割日后十三日内", n: "交割日后六十日内" }]), /对方的插入或删除/);
  const ok = docXml(revise(docx, [{ a: "办理变更登记", n: "办理市场监督管理部门变更登记" }]));
  assert.ok(wellFormed(ok));
  assert.match(ok, /<w:ins w:id="80" w:author="对方律师"[^>]*><w:r><w:t xml:space="preserve">三<\/w:t><\/w:r><\/w:ins>/, "对方的修订原样保留");
  const fn = withBody(p(`${r("依据《公司法》")}<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="2"/></w:r>${r("第八十四条")}`));
  assert.throws(() => revise(fn, [{ a: "《公司法》第八十四条", n: "《公司法》第八十五条" }]), /脚注引用/);
  assert.match(docXml(revise(fn, [{ a: "第八十四条", n: "第八十五条" }])), /<w:footnoteReference w:id="2"\/>/, "缩到纯文字后可改，脚注引用保留");
});

test("D12：清洁稿接受移动修订、去掉格式修订记录，脚注里的修订一并接受", () => {
  const body = [
    p(`<w:moveFrom w:id="1" w:author="对方律师" w:date="2026-10-01T00:00:00Z">${r("被移走的句子。")}</w:moveFrom>${r("其余文字。")}`),
    p(`${r("目标段落。")}<w:moveTo w:id="2" w:author="对方律师" w:date="2026-10-01T00:00:00Z">${r("被移走的句子。")}</w:moveTo>`),
    `<w:p><w:pPr><w:jc w:val="center"/><w:pPrChange w:id="3" w:author="对方律师" w:date="2026-10-01T00:00:00Z"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>${r("居中段落。", `<w:rPr><w:b/><w:rPrChange w:id="4" w:author="对方律师" w:date="2026-10-01T00:00:00Z"><w:rPr/></w:rPrChange></w:rPr>`)}</w:p>`,
  ].join("");
  const footnotes = `<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="2"><w:p><w:del w:id="5" w:author="对方律师" w:date="2026-10-01T00:00:00Z"><w:r><w:delText>旧注</w:delText></w:r></w:del><w:ins w:id="6" w:author="对方律师" w:date="2026-10-01T00:00:00Z">${r("新注")}</w:ins></w:p></w:footnote></w:footnotes>`;
  const clean = sanitizeDocx(withBody(body, { "word/footnotes.xml": footnotes })).docx;
  const xml = docXml(clean);
  assert.deepEqual(texts(clean), ["其余文字。", "目标段落。被移走的句子。", "居中段落。"]);
  assert.doesNotMatch(xml, /moveFrom|moveTo|rPrChange|pPrChange|对方律师/);
  assert.match(xml, /<w:jc w:val="center"\/>/, "格式按修订后的生效");
  const fnXml = readZipEntries(clean).get("word/footnotes.xml")!.toString("utf8");
  assert.doesNotMatch(fnXml, /<w:(ins|del)\b|旧注/);
  assert.match(fnXml, /新注/);
});

test("D14：数字字符引用解码（&#160; &#x4E09;），改同一 run 后正文不出现字面引用", () => {
  const docx = withBody(p(r("金额&#160;100元，期限&#x4E09;十日。")));
  assert.equal(mapParagraphs(docXml(docx))[0]!.text, "金额 100元，期限三十日。");
  const clean = sanitizeDocx(revise(docx, [{ a: "期限三十日", n: "期限六十日" }])).docx;
  assert.equal(texts(clean)[0], "金额 100元，期限六十日。");
  assert.doesNotMatch(docXml(clean), /&amp;#/);
  assert.equal(texts(sanitizeDocx(revise(docx, [{ a: "金额 100元", n: "金额 200元" }])).docx)[0], "金额 200元，期限三十日。", "普通空格也能对上不间断空格，原样保留 NBSP");
});

test("自动编号与段落切分一致：空段落、文本框里的段落不打乱编号对应", () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const numbering = `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="第%1条"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const n = `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>`;
  const box = `<w:r><w:drawing><wp:inline xmlns:wp="x"><w:txbxContent><w:p>${r("文本框文字")}</w:p></w:txbxContent></wp:inline></w:drawing></w:r>`;
  const docx = withBody([`<w:p>${n}${r("总则")}</w:p>`, `<w:p/>`, `<w:p>${n}${r("价款")}${box}${r("见附件。")}</w:p>`, `<w:p>${n}${r("其他")}</w:p>`].join(""), { "word/numbering.xml": numbering });
  assert.deepEqual(docxListLabels(docx), ["第一条", null, "第二条", "第三条"]);
  assert.deepEqual(texts(docx), ["总则", "", "价款见附件。", "其他"], "文本框里的文字不混进外层段落");
  assert.deepEqual(texts(sanitizeDocx(revise(docx, [{ a: "见附件", n: "见附件一" }])).docx)[2], "价款见附件一。");
});
