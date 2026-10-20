/**
 * v9.3 第 15 批 B-4（评审 Z1 P1-1）：文书版式——本机设置函头、字体、页码与律所模板；下载时本产品生成的 Word 重新套版式，
 * Markdown 成果可“下载 Word”；预览与成果登记的字节不变；律师上传的原件不动；模板读不出样式的拒收。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDocx, extractParagraphs, isHouseStyled, readZipEntries, writeRawZip } from "@zr-legal/docx-engine";
import { makeKernel, type TestKernel } from "./helpers.ts";

let tk: TestKernel | null = null;
after(async () => {
  await tk?.kernel.close().catch(() => {});
});

const part = (buf: Buffer, name: string) => readZipEntries(buf).get(name)?.toString("utf8") ?? "";

test("B-4 文书版式：设置、模板、下载时套版式、Markdown 下载 Word、样张", { timeout: 120_000 }, async () => {
  tk = await makeKernel({}, "docstyle-firm");
  const { inv, kernel } = tk;
  const ident = (kernel as any).identity as { tenantId: string; userId: string };
  const { matter } = await inv("matters.create", { title: "版式", stance: "原告", consent_status: "not_required" });
  const reg = (filename: string, bytes: Buffer) => {
    const { sha256, storage_uri } = kernel.blobs.put(bytes, matter.matter_id);
    const id = `artv_${randomUUID()}`;
    kernel.db.run(
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, audience, version, filename, sha256, storage_uri, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'draft', ?)`,
      [id, ident.tenantId, matter.matter_id, null, `test_${filename}`, "internal", 1, filename, sha256, storage_uri, ident.userId],
    );
    return { id, sha256 };
  };

  // 缺省：开发形态没有激活记录，自动函头没有名称可用 → 不加函头；宋体小四、带页码
  const v0 = await inv("doc_style.get");
  assert.equal(v0.letterhead, "auto");
  assert.equal(v0.effective_letterhead, null);
  assert.equal(v0.body, "song-xiaosi");
  assert.equal(v0.page_numbers, true);
  await assert.rejects(inv("doc_style.set", { letterhead: "custom", letterhead_name: "  " }), /律所名称/);
  const v1 = await inv("doc_style.set", { letterhead: "custom", letterhead_name: "示例律师事务所", letterhead_lines: ["北京市朝阳区某路 1 号", "010-12345678", "第三行不要"], body: "fangsong-san" });
  assert.equal(v1.effective_letterhead, "示例律师事务所");
  assert.deepEqual(v1.letterhead_lines, ["北京市朝阳区某路 1 号", "010-12345678"]);

  // 本产品生成的 Word：下载时加函头、换仿宋三号；登记的字节与哈希不变；预览不套
  const gen = reg("意见书.docx", createDocx("法律意见书", [{ heading: "一、事实", paragraphs: ["正文。"] }]));
  const d = await inv("artifacts.download", { artifact_version_id: gen.id });
  const out = Buffer.from(d.data_base64, "base64");
  assert.match(part(out, "word/header1.xml"), /示例律师事务所[\s\S]*北京市朝阳区某路 1 号/);
  assert.match(part(out, "word/styles.xml"), /w:eastAsia="仿宋"/);
  assert.notEqual(d.exported_sha256, gen.sha256);
  assert.equal(d.sha256, gen.sha256, "登记的哈希不变");
  assert.deepEqual(extractParagraphs(out).map((p) => p.text), ["法律意见书", "一、事实", "正文。"]);
  const preview = await inv("artifacts.download", { artifact_version_id: gen.id, restore: false });
  assert.equal(part(Buffer.from(preview.data_base64, "base64"), "word/header1.xml"), "", "预览不套版式");

  // 律师上传或对方给的文件（没有本产品标记）：原样
  const foreign = writeRawZip([
    { name: "[Content_Types].xml", data: Buffer.from(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`) },
    { name: "word/document.xml", data: Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>对方草稿</w:t></w:r></w:p></w:body></w:document>`) },
  ]);
  const f = reg("对方草稿.docx", foreign);
  const fd = await inv("artifacts.download", { artifact_version_id: f.id });
  assert.equal(part(Buffer.from(fd.data_base64, "base64"), "word/header1.xml"), "");

  // Markdown 成果“下载 Word”：套同一版式、文件名改 .docx；不带 as 时照旧下载 Markdown
  const md = reg("研究备忘录.md", Buffer.from("# 研究备忘录\n\n## 结论\n建议**补足出资**。\n\n某某律师事务所\n2026年10月20日\n", "utf8"));
  const asWord = await inv("artifacts.download", { artifact_version_id: md.id, as: "docx" });
  assert.equal(asWord.filename, "研究备忘录.docx");
  const w = Buffer.from(asWord.data_base64, "base64");
  assert.ok(isHouseStyled(w));
  assert.match(part(w, "word/header1.xml"), /示例律师事务所/);
  assert.deepEqual(extractParagraphs(w).map((p) => p.text), ["研究备忘录", "结论", "建议补足出资。", "某某律师事务所", "2026年10月20日"]);
  const asMd = await inv("artifacts.download", { artifact_version_id: md.id });
  assert.equal(asMd.filename, "研究备忘录.md");
  assert.match(Buffer.from(asMd.data_base64, "base64").toString("utf8"), /补足出资/);

  // 律所模板：读不出样式的拒收；上传后页眉取自模板、函头设置不再用；移除后恢复
  await assert.rejects(inv("doc_style.set_template", { filename: "模板.docx", data_base64: Buffer.from("不是 zip").toString("base64") }), /读不出 Word 样式/);
  await assert.rejects(inv("doc_style.set_template", { filename: "模板.pdf", data_base64: Buffer.from("x").toString("base64") }), /\.dotx/);
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const tpl = writeRawZip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "word/styles.xml", data: Buffer.from(`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style></w:styles>`) },
    { name: "word/document.xml", data: Buffer.from(`<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:sectPr><w:headerReference w:type="default" r:id="rId1"/></w:sectPr></w:body></w:document>`) },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/header" Target="header1.xml"/></Relationships>`) },
    { name: "word/header1.xml", data: Buffer.from(`<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>衡序律师事务所（模板页眉）</w:t></w:r></w:p></w:hdr>`) },
  ]);
  const vt = await inv("doc_style.set_template", { filename: "衡序模板.dotx", data_base64: tpl.toString("base64") });
  assert.equal(vt.template.name, "衡序模板.dotx");
  const withTpl = Buffer.from((await inv("artifacts.download", { artifact_version_id: gen.id })).data_base64, "base64");
  assert.match(part(withTpl, "word/header1.xml"), /模板页眉/);
  assert.doesNotMatch(part(withTpl, "word/header1.xml"), /示例律师事务所/);
  assert.equal((await inv("doc_style.clear_template")).template, null);
  assert.match(part(Buffer.from((await inv("artifacts.download", { artifact_version_id: gen.id })).data_base64, "base64"), "word/header1.xml"), /示例律师事务所/);

  // 样张：按当前版式生成一页虚构内容
  const sample = Buffer.from((await inv("doc_style.sample")).data_base64, "base64");
  assert.match(part(sample, "word/header1.xml"), /示例律师事务所/);
  assert.match(part(sample, "word/document.xml"), /样张/);
  // 不加函头
  await inv("doc_style.set", { letterhead: "none" });
  assert.equal(part(Buffer.from((await inv("artifacts.download", { artifact_version_id: gen.id })).data_base64, "base64"), "word/header1.xml"), "");
});
