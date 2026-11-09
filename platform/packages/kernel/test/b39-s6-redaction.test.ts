/**
 * V14 第 39 批（T2-D 客户版与对外脱敏，独立评分命中否决）：脱敏件里乙方旧账号 6225884403051277303 完整留在修订删除痕迹里，
 * 页脚“钱予墨 13823519076”原样保留，3 处修订与修订作者、修订模式都在；报告却写“全部遮盖”。
 * 根因：只在原件正文上遮盖（扫描用可见文字，删除痕迹与页眉页脚都不在范围），也没有先接受修订。
 * 修复后：先接受全部修订、清空批注、去掉修订作者与修订模式，再扫描并遮盖正文（含表格）、页眉、页脚、脚注；对公账号按“账号”上下文识别。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, readZipEntries, writeZip } from "@zr-legal/docx-engine";
import { downloadArtifact, importBytes, makeKernel, runScenario, type TestKernel } from "./helpers.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b39-s6-firm");
});
after(async () => {
  await tk.kernel.close();
});

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const P = (body: string) => `<w:p>${body}</w:p>`;
const AUTH = 'w:author="林溪（禾屿法务）" w:date="2026-03-02T09:00:00Z"';
const BODY = [
  P(R("乙方收款账户：开户行招商银行深圳科苑支行，账号：") + `<w:del w:id="1" ${AUTH}><w:r><w:delText xml:space="preserve">6225884403051277303</w:delText></w:r></w:del>` + `<w:ins w:id="2" ${AUTH}>${R("6225884403051960429")}</w:ins>` + R("。")),
  P(R("甲方对公账号：31001501200050012345（非银行卡号）。") + `<w:commentRangeStart w:id="0"/>` + R("授权代表叶栖迟，身份证号310104199002143262，手机13917026648。") + `<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>`),
  `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc>${P(R("驻场工程师"))}</w:tc><w:tc>${P(R("邬起航 18616250937"))}</w:tc></w:tr></w:tbl>`,
].join("");

function docx(): Buffer {
  const files = readZipEntries(createDocx("维保合同", [{ heading: "x", paragraphs: ["y"] }], { mark: false }));
  files.set("word/document.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${BODY}<w:sectPr/></w:body></w:document>`));
  files.set("word/footer1.xml", Buffer.from(`<w:ftr ${W}>${P(R("乙方联系人：钱予墨 13823519076"))}</w:ftr>`));
  files.set("word/settings.xml", Buffer.from(`<w:settings ${W}><w:trackRevisions/></w:settings>`));
  files.set("word/comments.xml", Buffer.from(`<w:comments ${W}><w:comment w:id="0" w:author="林溪（禾屿法务）"><w:p><w:r><w:t>核对授权代表身份证 310104199002143262</w:t></w:r></w:p></w:comment></w:comments>`));
  return writeZip([...files].map(([name, data]) => ({ name, data })));
}

test("对外脱敏：删除痕迹、页脚、表格、批注里的账号、身份证号、手机号都不残留；不带修订、修订作者与修订模式；表格保留", { timeout: 120_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "维保合同脱敏", stance: "委托方", consent_status: "agreed" });
  const doc = await importBytes(inv, matter.matter_id, "维保合同（签署版）.docx", docx(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const { run, artifacts } = await runScenario(inv, matter.matter_id, "s6.redaction", { document_version_ids: [doc.document_version_id] });
  assert.equal(run.status, "succeeded");
  const out = readZipEntries(await downloadArtifact(inv, artifacts.find((a: any) => a.kind === "s6_redacted").artifact_version_id));
  const all = [...out].filter(([n]) => n.endsWith(".xml")).map(([, b]) => b.toString("utf8")).join("\n");
  for (const v of ["6225884403051277303", "6225884403051960429", "31001501200050012345", "310104199002143262", "13917026648", "18616250937", "13823519076"]) {
    assert.equal(all.includes(v), false, `${v} 仍在脱敏件里`);
  }
  assert.equal(/<w:(?:ins|del)\b/.test(all), false, "不带修订");
  assert.equal(all.includes("林溪"), false, "修订与批注作者不留");
  assert.equal(/<w:trackRevisions\b/.test(all), false, "修订模式关闭");
  assert.equal(/<w:comment\b/.test(all), false, "批注清空");
  assert.match(out.get("word/document.xml")!.toString("utf8"), /<w:tbl>/, "表格保留为表格");
  const rep = artifacts.find((a: any) => a.kind === "s6_report");
  const repText = (readZipEntries(await downloadArtifact(inv, rep.artifact_version_id)).get("word/document.xml")!.toString("utf8")).replace(/<[^>]+>/g, "");
  assert.match(repText, /银行账号 2 处/, repText);
  assert.match(repText, /接受修订 2 处/);
  assert.match(repText, /页眉、页脚/);
});
