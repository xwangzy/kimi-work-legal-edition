/**
 * Office 打开产物零外部请求（v9 第 04 篇 §1.2 第 3 条；复核 S5-B04）：S6 脱敏在“未发现需遮盖的标识符”时同样产出经文书引擎写出的脱敏件——
 * 原件里的附加模板、INCLUDEPICTURE 域等外取引用不随成果带出，文档属性（作者）净化；原件不变。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDocx, findExternalRefs, readZipEntries, readZipText, writeRawZip } from "@zr-legal/docx-engine";
import { makeKernel, importBytes, runScenario, type TestKernel } from "./helpers.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({ ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off" }, "office-refs-firm");
});

after(async () => {
  await tk.kernel.close();
});

const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** 不含证件、账户、联系方式的原件，带附加模板（UNC）与 INCLUDEPICTURE 域、作者属性。 */
function originalDocx(): Buffer {
  const files = readZipEntries(createDocx("会议纪要", [{ heading: "一、议题", paragraphs: ["讨论租赁合同续签安排。"] }]));
  files.set(
    "word/_rels/document.xml.rels",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rIdS" Type="${R_NS}/settings" Target="settings.xml"/></Relationships>`,
    ),
  );
  files.set(
    "word/settings.xml",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${R_NS}"><w:attachedTemplate r:id="rIdT"/></w:settings>`),
  );
  files.set(
    "word/_rels/settings.xml.rels",
    Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdT" Type="${R_NS}/attachedTemplate" Target="file:///\\\\fileserver\\templates\\firm.dotm" TargetMode="External"/></Relationships>`),
  );
  const doc = files
    .get("word/document.xml")!
    .toString("utf8")
    .replace("<w:sectPr/>", `<w:p><w:fldSimple w:instr=" INCLUDEPICTURE &quot;http://tracker.example/p.png&quot; \\d "><w:r><w:t>附图</w:t></w:r></w:fldSimple></w:p><w:sectPr/>`);
  files.set("word/document.xml", Buffer.from(doc, "utf8"));
  const core = files.get("docProps/core.xml")!.toString("utf8").replace(/<dc:creator>[\s\S]*?<\/dc:creator>/, "<dc:creator>内部起草人甲</dc:creator>");
  files.set("docProps/core.xml", Buffer.from(core, "utf8"));
  return writeRawZip([...files.entries()].map(([name, data]) => ({ name, data })));
}

test("S6 脱敏零命中：脱敏件经文书引擎写出——零外取引用、作者属性已净化；原件不变（复核 S5-B04）", { timeout: 120_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "纪要脱敏", stance: "受让方", consent_status: "not_required" });
  const original = originalDocx();
  assert.ok(findExternalRefs(readZipEntries(original)).length >= 2, "对照：原件含外取引用");
  const doc = await importBytes(inv, matter.matter_id, "会议纪要.docx", original, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const { run, artifacts } = await runScenario(inv, matter.matter_id, "s6.redaction", { document_version_ids: [doc.document_version_id] });
  assert.equal(run.status, "succeeded", JSON.stringify(run));
  const redacted = artifacts.find((a: any) => a.kind === "s6_redacted");
  assert.ok(redacted, "应有脱敏件");
  const dl = await inv("artifacts.download", { artifact_version_id: redacted.artifact_version_id });
  const buf = Buffer.from(dl.data_base64, "base64");
  assert.deepEqual(findExternalRefs(readZipEntries(buf)), [], "脱敏件零外取引用");
  assert.ok(!readZipText(buf, "docProps/core.xml")!.includes("内部起草人甲"), "作者属性已净化");
  assert.notEqual(dl.sha256, doc.sha256 ?? "", "脱敏件不是原件字节");
  // 原件不变（材料库中的原件仍含原引用，未被改写）
  const orig = tk.kernel.db.get<{ sha256: string }>(`SELECT sha256 FROM document_versions WHERE document_version_id = ?`, [doc.document_version_id]);
  assert.ok(orig?.sha256, "原件版本仍在");
});
