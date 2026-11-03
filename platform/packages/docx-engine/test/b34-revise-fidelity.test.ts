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
  assert.throws(() => revise(fn, [{ a: "《公司法》第八十四条", n: "《民法典》第五百条" }]), /脚注引用/, "要改的文字盖住脚注引用的拒写");
  assert.match(docXml(revise(fn, [{ a: "第八十四条", n: "第八十五条" }])), /<w:footnoteReference w:id="2"\/>/, "缩到纯文字后可改，脚注引用保留");
  assert.match(docXml(revise(fn, [{ a: "《公司法》第八十四条", n: "《公司法》第八十五条" }])), /<w:footnoteReference w:id="2"\/>/, "锚点带上脚注引用、改动只在一侧的照写，脚注引用保留");
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

test("在对方插入的文字里再改（不接受对方把“连带责任保证”改成“一般保证”）：删除嵌在对方插入里、我方插入放在外面", () => {
  const theirsDel = `<w:del w:id="70" w:author="对方律师" w:date="2026-10-01T00:00:00Z"><w:r><w:delText>连带责任保证</w:delText></w:r></w:del>`;
  const theirsIns = `<w:ins w:id="71" w:author="对方律师" w:date="2026-10-01T00:00:00Z">${r("一般保证")}</w:ins>`;
  const docx = withBody(p(`${r("11.1 丙方对乙方的全部债务承担")}${theirsDel}${theirsIns}${r("。")}`));
  const rev = docXml(revise(docx, [{ a: "一般保证", n: "连带责任保证" }]));
  assert.ok(wellFormed(rev));
  // 最小改动保留共同的“保证”：删“一般”嵌在对方插入里，我方插入“连带责任”在外面，对方插入用新编号接上“保证”
  assert.match(rev, /<w:ins w:id="71" w:author="对方律师"[^>]*><w:del [^>]*author="测试"[^>]*><w:r><w:delText xml:space="preserve">一般<\/w:delText><\/w:r><\/w:del><\/w:ins><w:ins [^>]*author="测试"[^>]*><w:r><w:t xml:space="preserve">连带责任<\/w:t><\/w:r><\/w:ins><w:ins w:id="(?!71")\d+" w:author="对方律师"[^>]*><w:r><w:t xml:space="preserve">保证<\/w:t><\/w:r><\/w:ins>/);
  assert.doesNotMatch(rev, /<w:ins [^>]*>(?:(?!<\/w:ins>)[\s\S])*<w:ins /, "插入里没有再套插入");
  assert.doesNotMatch(revise(docx, [{ a: "一般", n: "连带责任" }]).toString("latin1"), /kwl-reopen/, "临时标记已去掉");
  assert.doesNotMatch(docXml(revise(docx, [{ a: "一般", n: "连带责任" }])), /<w:ins [^>]*><\/w:ins>/, "对方插入改完没有剩下空的插入标签");
  assert.deepEqual(texts(sanitizeDocx(revise(docx, [{ a: "一般保证", n: "连带责任保证" }])).docx), ["11.1 丙方对乙方的全部债务承担连带责任保证。"]);
  assert.deepEqual(texts(sanitizeDocx(revise(docx, [{ a: "承担一般保证", n: "承担连带责任保证" }])).docx), ["11.1 丙方对乙方的全部债务承担连带责任保证。"], "锚点跨过对方插入的边界、改动本身在插入之内的照写");
  assert.throws(() => revise(docx, [{ a: "承担一般保证", n: "提供保证" }]), /对方的插入或删除/, "改动本身跨过对方插入边界的仍拒写");
});

test("锚点带上对方插入外面的原文、改动只在插入之内：照写，锚点里没变的 run 字节不动（第 34 批 T3b 真实走查：借款合同 11.1 对方只插入“一般”二字）", () => {
  const theirsDel = `<w:del w:id="104" w:author="对方律师" w:date="2026-10-28T15:20:00Z"><w:r><w:delText xml:space="preserve">连带责任</w:delText></w:r></w:del>`;
  const theirsIns = `<w:ins w:id="105" w:author="对方律师" w:date="2026-10-28T15:20:00Z">${r("一般")}</w:ins>`;
  const head = r("丙方自愿为乙方在本合同项下的全部债务提供", "<w:rPr><w:b/></w:rPr>");
  const tail = r("保证。");
  const docx = withBody(p(`${head}${theirsDel}${theirsIns}${tail}`));
  for (const a of ["一般保证", "提供一般保证", "全部债务提供一般保证。"]) {
    const n = a.replace("一般", "连带责任");
    const rev = docXml(revise(docx, [{ a, n }]));
    assert.ok(wellFormed(rev), a);
    assert.ok(rev.includes(head) && rev.includes(tail), `${a}：锚点里没变的开头、结尾 run 原样保留`);
    assert.ok(rev.includes(theirsDel), `${a}：对方的删除原样保留`);
    assert.deepEqual(texts(sanitizeDocx(revise(docx, [{ a, n }])).docx), ["丙方自愿为乙方在本合同项下的全部债务提供连带责任保证。"], a);
  }
  assert.throws(() => revise(docx, [{ a: "一般保证", n: "特别担保" }]), /对方的插入或删除/, "改动跨过插入与原文的边界仍拒写");
});

test("表格里同一行、跨行重复的金额：条款提示写“行名｜列名”定位到那一格（第 34 批 T3 真实走查：还款表 12 格因金额重复没写入）", () => {
  const tc = (t: string) => `<w:tc>${p(r(t))}</w:tc>`;
  const row = (...xs: string[]) => `<w:tr>${xs.map(tc).join("")}</w:tr>`;
  const table = `<w:tbl>${row("期次", "应还本金", "应还利息", "本期合计")}${row("第 1 期", "0", "75,000.00", "75,000.00")}${row("第 2 期", "1,500,000.00", "75,000.00", "1,575,000.00")}${row("第 3 期", "1,500,000.00", "52,500.00", "1,552,500.00")}</w:tbl>`;
  const docx = withBody(table + p(r("其他")));
  const clean = sanitizeDocx(
    revise(docx, [
      { a: "75,000.00", n: "67,500.00", hint: "第 1 期｜应还利息" },
      { a: "75,000.00", n: "67,500.00", hint: "第1期｜本期合计" },
      { a: "75,000.00", n: "67,500.00", hint: "第 2 期｜应还利息" },
      { a: "1,500,000.00", n: "1,350,000.00", hint: "第 2 期｜应还本金" },
      { a: "1,500,000.00", n: "1,350,000.00", hint: "第 3 期" },
    ]),
  ).docx;
  assert.deepEqual(texts(clean).slice(4, 16), ["第 1 期", "0", "67,500.00", "67,500.00", "第 2 期", "1,350,000.00", "67,500.00", "1,575,000.00", "第 3 期", "1,350,000.00", "52,500.00", "1,552,500.00"]);
  assert.throws(() => revise(docx, [{ a: "75,000.00", n: "67,500.00", hint: "第 1 期" }]), /锚点歧义/, "同一行两格相同、只给行名仍拒写");
});

test("最小改动不在数字、金额、日期中间切开（第 34 批律师验收：13.50 改 14.20 显示成“1[-3.5-][+4.2+]0”）", async () => {
  const { minimalChange } = await import("../src/revise.ts");
  assert.deepEqual(minimalChange("单价 13.50 元/kg", "单价 14.20 元/kg"), { keepHead: "单价 ", removed: "13.50", added: "14.20", keepTail: " 元/kg" });
  assert.equal(minimalChange("1,575,000.00", "1,417,500.00").removed, "1,575,000.00");
  assert.equal(minimalChange("自 2025 年 3 月 12 日起", "自 2026 年 1 月 1 日起").removed, "2025 年 3 月 12");
  assert.deepEqual(minimalChange("第一条", "第二条"), { keepHead: "第", removed: "一", added: "二", keepTail: "条" }, "非数字的文字照旧只标改动的字");
});

test("交付的 Excel 不是“裸表”：首行表头加粗冻结、正文换行有边框、金额千分位、列宽按文字估（第 34 批独立律师验收）", async () => {
  const { createXlsx } = await import("../src/xlsx.ts");
  const long = "一年期LPR 3.35%（2024-07-22报价）；合同16.1及律师选定口径；".repeat(3);
  const files = readZipEntries(createXlsx([{ name: "计算明细", rows: [["段号", "计息本金", "金额", "说明"], [1, 3945000, 4706.98, long], [2026, 12, 0.5, "短"]] }, { name: "空表", rows: [] }]));
  const ct = files.get("[Content_Types].xml")!.toString("utf8");
  const rels = files.get("xl/_rels/workbook.xml.rels")!.toString("utf8");
  const styles = files.get("xl/styles.xml")?.toString("utf8") ?? "";
  const sheet = files.get("xl/worksheets/sheet1.xml")!.toString("utf8");
  assert.match(ct, /PartName="\/xl\/styles\.xml"/);
  assert.match(rels, /relationships\/styles" Target="styles\.xml"/);
  for (const part of ["[Content_Types].xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]) assert.ok(wellFormed(files.get(part)!.toString("utf8")), part);
  assert.match(sheet, /<sheetViews>.*state="frozen".*<\/sheetViews><cols>.*<\/cols><sheetData>/, "冻结表头；元素次序 sheetViews → cols → sheetData");
  assert.match(sheet, /<c r="A1" s="1" t="inlineStr">/, "表头样式");
  assert.match(sheet, /<c r="B2" s="3"><v>3945000<\/v>/, "一万以上整数千分位");
  assert.match(sheet, /<c r="C2" s="4"><v>4706\.98<\/v>/, "小数两位千分位");
  assert.match(sheet, /<c r="A3" s="5"><v>2026<\/v>/, "年份、序号等小整数不加千分位");
  assert.match(sheet, /<c r="D2" s="2" t="inlineStr">/, "正文文字换行有边框");
  assert.match(sheet, /<col min="4" max="4" width="60" customWidth="1"\/>/, "长文字列封顶 60，靠换行");
  assert.match(sheet, /<col min="1" max="1" width="6" customWidth="1"\/>/, "短列不小于 6");
  assert.match(styles, /<cellXfs count="6">/);
  assert.equal((styles.match(/<xf numFmtId=/g) ?? []).length, 7, "cellStyleXfs 1 个 + cellXfs 6 个");
  assert.doesNotMatch(files.get("xl/worksheets/sheet2.xml")!.toString("utf8"), /<cols>|<sheetViews>/, "空表不写列宽、不冻结");
});

test("几张表的行名列名相同：提示前加表格前一段的条款号或文字区分（第 35 批 R5 真实走查：价款构成表与付款表的“合计｜金额（元）”都没写入）", () => {
  const tc = (t: string) => `<w:tc>${p(r(t))}</w:tc>`;
  const row = (...xs: string[]) => `<w:tr>${xs.map(tc).join("")}</w:tr>`;
  const price = `<w:tbl>${row("项目", "金额（元）")}${row("软件许可费", "1,500,000.00")}${row("合计", "2,860,000.00")}</w:tbl>`;
  const pay = `<w:tbl>${row("期次", "比例", "金额（元）")}${row("签约", "40%", "1,144,000.00")}${row("合计", "100%", "2,860,000.00")}</w:tbl>`;
  const docx = withBody(p(r("2.1 本合同总价构成如下：")) + price + p(r("3.1 甲方按下表付款：")) + pay + p(r("其他")));
  assert.throws(() => revise(docx, [{ a: "2,860,000.00", n: "2,580,000.00", hint: "合计｜金额（元）" }]), /锚点歧义/, "只写行名列名，两张表都对上：仍拒写");
  const clean = sanitizeDocx(
    revise(docx, [
      { a: "2,860,000.00", n: "2,580,000.00", hint: "2.1｜合计｜金额（元）" },
      { a: "2,860,000.00", n: "2,580,000.00", hint: "甲方按下表付款｜合计｜金额（元）" },
    ]),
  ).docx;
  const t = texts(clean);
  assert.equal(t.filter((x) => x === "2,580,000.00").length, 2, t.join(" / "));
  assert.ok(!t.includes("2,860,000.00"));
  assert.throws(() => revise(docx, [{ a: "2,860,000.00", n: "2,580,000.00", hint: "4.1｜合计｜金额（元）" }]), /锚点歧义/, "条款号对不上任何一张表：拒写，不改第一处");
});

test("修订稿打开 Word 的“修订”开关，清洁稿关掉（第 35 批 R5 律师评分：律师在修订稿上续改时不留痕）", () => {
  const docx = withBody(p(r("3.1 甲方应于验收合格后三十日内付款。")), { "word/settings.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/></w:settings>` });
  const rev = revise(docx, [{ a: "三十日", n: "十五日" }]);
  assert.match(readZipEntries(rev).get("word/settings.xml")!.toString("utf8"), /<w:settings[^>]*><w:zoom w:percent="100"\/><w:trackRevisions\/>/, "V11 F5：按 CT_Settings 次序写在 w:zoom 之后");
  const clean = sanitizeDocx(rev).docx;
  assert.doesNotMatch(readZipEntries(clean).get("word/settings.xml")!.toString("utf8"), /trackRevisions/);
  const again = revise(rev, [{ a: "验收合格", n: "最终验收合格" }]);
  assert.equal((readZipEntries(again).get("word/settings.xml")!.toString("utf8").match(/<w:trackRevisions\/>/g) ?? []).length, 1, "已打开的不重复加");
});
