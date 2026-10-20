/**
 * 律所版式（v9.3 第 15 批 B-4；评审 Z1 P1-1）：生成的 Word 带 A4 页面、字体字号、标题居中、页码、落款右对齐；
 * 导出时按律所设置加函头或套律所模板（样式与页眉页脚取自模板，徽标图片一并带上）；只有本产品生成的文件会被重新套版式；写出零外取引用。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, createStyledDocx, extractParagraphs, findExternalRefs, HOUSE_STYLE_MARK, isHouseStyled, markdownToBlocks, readTemplate, readZipEntries, restyleDocx, writeRawZip } from "../src/index.ts";

const text = (buf: Buffer, part: string) => readZipEntries(buf).get(part)?.toString("utf8") ?? "";

test("B-4 生成的 Word：A4 与公文页边距、样式表、页脚页码、标记；正文顺序不变", () => {
  const d = createDocx("法律意见书", [{ heading: "一、事实", paragraphs: ["甲公司于 2026 年签约。", "乙公司未付款。"] }]);
  const doc = text(d, "word/document.xml");
  assert.match(doc, /<w:pgSz w:w="11906" w:h="16838"\/>/);
  assert.match(doc, /<w:pgMar w:top="2098" w:right="1474" w:bottom="1984" w:left="1587"/);
  assert.match(doc, /<w:pStyle w:val="KwlTitle"\/>/);
  assert.match(text(d, "word/styles.xml"), /w:eastAsia="宋体"[\s\S]*<w:sz w:val="24"\/>/, "缺省宋体小四");
  const footer = text(d, "word/footer1.xml");
  assert.match(footer, /第 [\s\S]*w:instr=" PAGE "[\s\S]*页 共 [\s\S]*w:instr=" NUMPAGES "/);
  assert.ok(isHouseStyled(d));
  assert.match(text(d, "docProps/core.xml"), new RegExp(HOUSE_STYLE_MARK));
  assert.deepEqual(extractParagraphs(d).map((p) => p.text), ["法律意见书", "一、事实", "甲公司于 2026 年签约。", "乙公司未付款。"]);
  assert.deepEqual(findExternalRefs(readZipEntries(d)), []);
  assert.equal(text(d, "word/header1.xml"), "", "没有函头设置：不加页眉");
});

test("B-4 Markdown → 正文块：标题、章节层级、列表、表格、加粗、落款右对齐", () => {
  const md = [
    "# 关于甲公司股权转让的法律意见书",
    "",
    "## 一、基本事实",
    "甲公司持有**乙公司 60%** 股权，见[工商档案](#a)。",
    "### （一）出资",
    "- 已实缴 300 万元",
    "1. 第二期未缴",
    "",
    "| 股东 | 比例 |",
    "|---|---|",
    "| 甲公司 | 60% |",
    "",
    "## 二、结论",
    "建议补足出资。",
    "",
    "某某律师事务所",
    "承办律师：张三",
    "2026年10月20日",
  ].join("\n");
  const b = markdownToBlocks(md);
  assert.deepEqual(
    b.map((x) => x.kind),
    ["title", "h1", "p", "h2", "li", "li", "table", "h1", "p", "right", "right", "right"],
  );
  const p = b[2] as { kind: "p"; runs: { text: string; bold?: boolean }[] };
  assert.deepEqual(p.runs, [{ text: "甲公司持有" }, { text: "乙公司 60%", bold: true }, { text: " 股权，见工商档案。" }]);
  const t = b[6] as { kind: "table"; rows: { text: string }[][][] };
  assert.deepEqual(t.rows.map((r) => r.map((c) => c.map((x) => x.text).join(""))), [["股东", "比例"], ["甲公司", "60%"]]);
  // 没有一级标题时，最高一级的 ## 当一级标题
  assert.deepEqual(markdownToBlocks("## 甲\n正文\n### 乙").map((x) => x.kind), ["h1", "p", "h2"]);
  // 正文中间提到律所名称不右对齐（只认文末）
  assert.equal(markdownToBlocks("某某律师事务所接受委托。\n\n## 分析\n正文").at(0)!.kind, "p");
  const docx = createStyledDocx(b);
  assert.match(text(docx, "word/document.xml"), /<w:tbl>[\s\S]*<w:tblBorders>/);
  assert.match(text(docx, "word/document.xml"), /<w:pStyle w:val="KwlRight"\/>[\s\S]*2026年10月20日/);
});

test("B-4 导出时套律所函头与字体；不是本产品生成的文件原样返回", () => {
  const d = createDocx("律师函", [{ heading: "", paragraphs: ["贵司拖欠货款。"] }]);
  const styled = restyleDocx(d, { letterhead: { name: "示例律师事务所", lines: ["北京市朝阳区某路 1 号 · 010-12345678"] }, body: "fangsong-san", pageNumbers: true });
  const hdr = text(styled, "word/header1.xml");
  assert.match(hdr, /示例律师事务所/);
  assert.match(hdr, /北京市朝阳区某路 1 号/);
  assert.match(hdr, /<w:bottom w:val="single"/, "函头下有横线");
  assert.match(text(styled, "word/styles.xml"), /w:eastAsia="仿宋"[\s\S]*<w:sz w:val="32"\/>/, "仿宋三号");
  assert.match(text(styled, "word/styles.xml"), /<w:spacing w:line="560" w:lineRule="exact"\/>/, "固定行距 28 磅");
  assert.deepEqual(extractParagraphs(styled).map((p) => p.text), extractParagraphs(d).map((p) => p.text), "正文不变");
  assert.match(text(styled, "word/document.xml"), /<w:headerReference w:type="default" r:id="rIdKwlHeader"\/>/);
  // 不要页码
  assert.equal(text(restyleDocx(d, { letterhead: null, body: "song-xiaosi", pageNumbers: false }), "word/footer1.xml"), "");
  // 律师上传的原件（没有标记）：不动
  const foreign = writeRawZip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "word/document.xml", data: Buffer.from(`<w:document xmlns:w="x"><w:body><w:p/></w:body></w:document>`) },
  ]);
  assert.equal(restyleDocx(foreign, { letterhead: { name: "甲", lines: [] }, body: "song-xiaosi", pageNumbers: true }), foreign);
});

test("B-4 律所模板：样式按名称对应、页眉（含徽标图片）与页脚取自模板；模板里的外部链接图片去掉", () => {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const tpl = writeRawZip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    {
      name: "word/styles.xml",
      data: Buffer.from(
        `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:rPr><w:rFonts w:eastAsia="方正仿宋_GBK"/></w:rPr></w:style>` +
          `<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/></w:style><w:style w:type="paragraph" w:styleId="a5"><w:name w:val="Title"/></w:style></w:styles>`,
      ),
    },
    { name: "word/document.xml", data: Buffer.from(`<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p/><w:sectPr><w:headerReference w:type="default" r:id="rId8"/><w:footerReference w:type="default" r:id="rId9"/></w:sectPr></w:body></w:document>`) },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId8" Type="${R}/header" Target="header2.xml"/><Relationship Id="rId9" Type="${R}/footer" Target="footer3.xml"/></Relationships>`) },
    { name: "word/header2.xml", data: Buffer.from(`<w:hdr xmlns:w="${W}" xmlns:r="${R}"><w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rIdLogo"/></w:drawing><w:t>衡序律师事务所</w:t></w:r></w:p><w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:link="rIdTrack"/></w:drawing></w:r></w:p></w:hdr>`) },
    { name: "word/_rels/header2.xml.rels", data: Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLogo" Type="${R}/image" Target="media/logo.png"/><Relationship Id="rIdTrack" Type="${R}/image" Target="http://tracker.example/t.png" TargetMode="External"/></Relationships>`) },
    { name: "word/footer3.xml", data: Buffer.from(`<w:ftr xmlns:w="${W}"><w:p><w:r><w:t>地址：上海市某路</w:t></w:r></w:p></w:ftr>`) },
    { name: "word/media/logo.png", data: png },
  ]);
  const t = readTemplate(tpl);
  assert.ok(t);
  assert.deepEqual(t!.ids, { h1: "1", title: "a5" });
  const d = createDocx("法律意见书", [{ heading: "一、事实", paragraphs: ["正文。"] }]);
  const out = restyleDocx(d, { letterhead: { name: "不应出现", lines: [] }, body: "song-xiaosi", pageNumbers: true }, t);
  const doc = text(out, "word/document.xml");
  assert.match(doc, /<w:pStyle w:val="a5"\/>[\s\S]*法律意见书/, "标题用模板的 Title 样式");
  assert.match(doc, /<w:pStyle w:val="1"\/>[\s\S]*一、事实/, "一级标题用模板的 heading 1");
  assert.match(doc, /<w:pStyle w:val="KwlBody"\/>/, "模板没有的正文样式用本产品的");
  const styles = text(out, "word/styles.xml");
  assert.match(styles, /方正仿宋_GBK/, "模板字体");
  assert.match(styles, /w:styleId="KwlBody"[\s\S]*<w:basedOn w:val="a"\/>/, "注入的样式基于模板的缺省段落样式");
  assert.match(text(out, "word/header1.xml"), /衡序律师事务所/, "页眉取自模板，不用函头设置");
  assert.doesNotMatch(text(out, "word/header1.xml"), /不应出现/);
  assert.match(text(out, "word/footer1.xml"), /地址：上海市某路/);
  assert.ok(readZipEntries(out).get("word/media/kwl-tpl-1.png")?.equals(png), "徽标图片带上（改名后放入，复核 R15A-08）");
  assert.match(text(out, "word/_rels/header1.xml.rels"), /Target="media\/kwl-tpl-1\.png"/);
  assert.match(text(out, "[Content_Types].xml"), /<Default Extension="png" ContentType="image\/png"\/>/);
  assert.doesNotMatch(text(out, "word/_rels/header1.xml.rels"), /tracker\.example/, "外部链接图片去掉");
  assert.deepEqual(findExternalRefs(readZipEntries(out)), []);
  assert.deepEqual(extractParagraphs(out).map((p) => p.text), ["法律意见书", "一、事实", "正文。"]);
  // 读不出的模板：null（导出照常用本产品版式）
  assert.equal(readTemplate(Buffer.from("不是 zip")), null);
});

test("B-4 重新套版式只换样式、页眉页脚与页面设置：批注、修订、关系与其他部件原样保留；示例合同与清洁稿不带标记", async () => {
  const { applyRevisionsToDocx, textToDocx } = await import("../src/index.ts");
  const { createHash } = await import("node:crypto");
  const d = createDocx("借款合同", [{ heading: "正文", paragraphs: ["借款人应于三日内付款。"] }]);
  const anchor = "三日内";
  const rev = applyRevisionsToDocx(d, {
    baselineHash: createHash("sha256").update(d).digest("hex"),
    ops: [{ opId: "op-1", anchor: { originalText: anchor }, originalHash: createHash("sha256").update(anchor).digest("hex"), newText: "五个工作日内", comment: "付款期限延长", author: "测试" }],
  }).docx;
  assert.match(text(rev, "word/comments.xml"), /付款期限延长/);
  // 复核 R15A-07：修订稿是派生文件，不带本产品标记，下载时不套函头
  assert.equal(isHouseStyled(rev), false);
  assert.equal(restyleDocx(rev, { letterhead: { name: "甲", lines: [] }, body: "song-xiaosi", pageNumbers: true }), rev);
  // 本产品生成、又带批注的文件（模拟）：重新套版式时批注、修订原样保留
  const files = readZipEntries(rev);
  files.set("docProps/core.xml", Buffer.from(text(d, "docProps/core.xml")));
  const marked = writeRawZip([...files].map(([name, data]) => ({ name, data })));
  assert.ok(isHouseStyled(marked));
  const out = restyleDocx(marked, { letterhead: { name: "示例律师事务所", lines: [] }, body: "song-xiaosi", pageNumbers: true });
  assert.match(text(out, "word/comments.xml"), /付款期限延长/, "批注还在");
  assert.match(text(out, "word/_rels/document.xml.rels"), /comments/, "批注的关系还在");
  assert.match(text(out, "[Content_Types].xml"), /comments\+xml/, "批注的内容类型还在");
  const doc = text(out, "word/document.xml");
  assert.match(doc, /<w:ins\b[\s\S]*五个工作日内/);
  assert.match(doc, /<w:del\b[\s\S]*三日内/);
  assert.match(text(out, "word/header1.xml"), /示例律师事务所/);
  assert.equal((doc.match(/<w:sectPr\b/g) ?? []).length, 1);
  assert.equal((text(out, "word/_rels/document.xml.rels").match(/\/styles"/g) ?? []).length, 1, "样式表关系只有一条");
  assert.deepEqual(findExternalRefs(readZipEntries(out)), []);
  // 不带标记：示例合同、清洁稿
  assert.equal(isHouseStyled(createDocx("示例合同", [{ heading: "", paragraphs: ["甲"] }], { mark: false })), false);
  assert.equal(isHouseStyled(textToDocx("清洁稿")), false);
});

test("复核 R15A-07/08/10/13、R15B-09/10/11/20/21/22：派生文件去标记；模板图片改名不覆盖正文图片；模板页眉引用别的部件不用；SVG 内容类型与外取；首页页眉；模板页面设置；属性顺序；Markdown 与落款边界", async () => {
  const { applyRevisionsToDocx, sanitizeDocx, scrubDocProps, textToDocx, templateLite, alignSignature } = await import("../src/index.ts");
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const d = createDocx("意见书", [{ heading: "一", paragraphs: ["正文"] }]);
  // 派生文件去标记
  assert.equal(isHouseStyled(scrubDocProps(d)), false);
  assert.equal(isHouseStyled(sanitizeDocx(d).docx), false);
  assert.equal(isHouseStyled(textToDocx("x")), false);
  // 模板：页眉徽标叫 media/image1.png，正文里也有 media/image1.png
  const logo = Buffer.from("89504e47aaaa", "hex");
  const bodyImg = Buffer.from("89504e47bbbb", "hex");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`);
  const tplFiles = (hdrRels: string, extra: { name: string; data: Buffer }[] = [], sect = `<w:headerReference w:type="default" r:id="rIdH"/><w:headerReference w:type="first" r:id="rIdF"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="500" w:footer="500" w:gutter="0"/><w:titlePg/>`) =>
    writeRawZip([
      { name: "[Content_Types].xml", data: Buffer.from(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="SVG" ContentType="image/svg+xml"/></Types>`) },
      { name: "word/styles.xml", data: Buffer.from(`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="a$&b"><w:name w:val="Normal"/></w:style></w:styles>`) },
      { name: "word/document.xml", data: Buffer.from(`<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:r><w:t>甲公司诉乙公司案的旧代理词正文</w:t></w:r></w:p><w:sectPr>${sect}</w:sectPr></w:body></w:document>`) },
      { name: "word/_rels/document.xml.rels", data: Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH" Type="${R}/header" Target="header3.xml"/><Relationship Id="rIdF" Type="${R}/header" Target="header4.xml"/></Relationships>`) },
      { name: "word/header3.xml", data: Buffer.from(`<w:hdr xmlns:w="${W}" xmlns:r="${R}"><w:p><w:r><w:t>衡序（各页）</w:t></w:r></w:p></w:hdr>`) },
      { name: "word/_rels/header3.xml.rels", data: Buffer.from(hdrRels) },
      { name: "word/header4.xml", data: Buffer.from(`<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>衡序律师事务所（首页函头）</w:t></w:r></w:p></w:hdr>`) },
      { name: "word/media/image1.png", data: logo },
      { name: "word/media/logo.svg", data: svg },
      ...extra,
    ]);
  const goodRels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="i1" Type="${R}/image" Target="media/image1.png"/><Relationship Id="i2" Type="${R}/image" Target="media/logo.svg"/></Relationships>`;
  const t = readTemplate(tplFiles(goodRels))!;
  assert.ok(t);
  assert.equal(t.titlePg, true);
  assert.match(t.headerText, /衡序（各页）/);
  assert.equal(t.media.get("media/kwl-tpl-2.svg")?.type, "image/svg+xml", "SVG 的内容类型按模板自己的登记（不区分大小写）");
  // 带标记、正文里有 media/image1.png 的文件
  const files = readZipEntries(d);
  files.set("word/media/image1.png", bodyImg);
  const withImg = writeRawZip([...files].map(([name, data]) => ({ name, data })));
  const out = restyleDocx(withImg, { letterhead: null, body: "song-xiaosi", pageNumbers: true }, t);
  assert.ok(readZipEntries(out).get("word/media/image1.png")?.equals(bodyImg), "正文图片不被模板徽标覆盖");
  assert.ok(readZipEntries(out).get("word/media/kwl-tpl-1.png")?.equals(logo));
  const doc = text(out, "word/document.xml");
  assert.match(doc, /<w:headerReference w:type="first"/);
  assert.match(doc, /<w:titlePg\/>/);
  assert.match(doc, /w:orient="landscape"/, "沿用模板的页面设置");
  assert.match(text(out, "word/header2.xml"), /首页函头/);
  // 样式编号带 $& 等特殊字符的不采用（复核 R15A-13）：模板原样式保留、不被替换模式搞乱
  assert.match(text(out, "word/styles.xml"), /w:styleId="a\$&b"/);
  assert.doesNotMatch(text(out, "word/styles.xml"), /<w:basedOn w:val="a[^"]*<w:/);
  assert.match(text(out, "[Content_Types].xml"), /Extension="svg" ContentType="image\/svg\+xml"/);
  // 模板页眉引用了图片以外的部件（批注）：这份页眉不用
  const bad = readTemplate(tplFiles(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="c" Type="${R}/comments" Target="comments.xml"/></Relationships>`, [{ name: "word/comments.xml", data: Buffer.from("<w:comments/>") }]))!;
  assert.equal(bad.header, null);
  // SVG 里有外取地址：这份页眉不用
  const evilSvg = readTemplate(tplFiles(goodRels, [{ name: "word/media/logo.svg", data: Buffer.from(`<svg><image href="http://tracker.example/x.png"/></svg>`) }]));
  assert.equal(evilSvg?.header ?? null, null);
  // 只保存用得到的部件：模板正文不进账本
  const lite = templateLite(tplFiles(goodRels))!;
  assert.ok(!lite.toString("latin1").includes(Buffer.from("旧代理词").toString("latin1")));
  assert.ok(!JSON.stringify([...readZipEntries(lite)].map(([, v]) => v.toString("utf8"))).includes("旧代理词"), "模板正文不保存（复核 R15A-09）");
  assert.match(readTemplate(lite)!.headerText, /衡序/);
  // 属性顺序（复核 R15B-11）：spacing 在 jc 前、pBdr 在 spacing 前
  const styles = text(createDocx("x", []), "word/styles.xml");
  assert.match(styles, /w:styleId="KwlTitle"[\s\S]*?<w:spacing [^>]*\/><w:jc w:val="center"\/>/);
  const hdr = text(restyleDocx(d, { letterhead: { name: "甲", lines: ["乙"] }, body: "song-xiaosi", pageNumbers: false }), "word/header1.xml");
  assert.match(hdr, /<w:pPr><w:pBdr>[\s\S]*?<\/w:pBdr><w:spacing [^>]*\/><w:jc w:val="center"\/><\/w:pPr>/);
  // Markdown 边界（复核 R15B-20）
  const b = markdownToBlocks(["# 一、事实", "金额 = 100000\\*0.05\\*3", "|---|---|", "", "| a | b |", "|:-:|-|", "| 1 | 2 |", "- 第一层", "  - 第二层", "# 二、分析", "正文"].join("\n"));
  assert.equal(b[0]!.kind, "h1", "有两个一级标题时不当文书标题");
  assert.equal((b[1] as any).runs.map((r: any) => r.text).join(""), "金额 = 100000*0.05*3");
  const tables = b.filter((x) => x.kind === "table") as any[];
  assert.equal(tables.length, 1, "只有对齐行的表格不输出");
  assert.deepEqual(tables[0].rows.map((r: any) => r.map((c: any) => c.map((x: any) => x.text).join(""))), [["a", "b"], ["1", "2"]], "单个横线的对齐行不当数据");
  assert.deepEqual(b.filter((x) => x.kind === "li").map((x: any) => x.level), [0, 1]);
  // 落款（复核 R15B-21）
  assert.equal(markdownToBlocks("正文\n\n如有疑问请联系某某律师事务所。").at(-1)!.kind, "p");
  assert.deepEqual(markdownToBlocks("正文\n\n答辩人：甲公司\n2026年10月20日").slice(-2).map((x) => x.kind), ["right", "right"]);
  // createDocx：落款右对齐，“落款与联系方式”不印成标题（复核 R15B-09）
  const letter = createDocx("律师函", [{ heading: "正文", paragraphs: ["贵司拖欠货款。"] }, { heading: "落款与联系方式", paragraphs: ["北京某某律师事务所", "律师：张三", "2026年10月20日"] }]);
  const lx = text(letter, "word/document.xml");
  assert.doesNotMatch(lx, />落款与联系方式</);
  assert.equal((lx.match(/<w:pStyle w:val="KwlRight"\/>/g) ?? []).length, 3);
  assert.equal(alignSignature([{ kind: "p", runs: [{ text: "正文" }] }])[0]!.kind, "p");
});
