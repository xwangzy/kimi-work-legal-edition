/**
 * 第 42 批：质量说明（“通用辅助 · 未经本所质量验收”“草稿 · 待律师复核”）不进交付文件——由内核直接删，不靠助手自觉。
 * 样本取自 V16 第二轮 57 张卡最终成果里的实际写法（23 张卡、27 份文件）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDeliverable, scrubQualityLine, scrubQualityRows, scrubQualitySections } from "../src/services/deliverable-check.ts";

test("独立成段的质量说明整段删掉（第二轮成果里的 6 种写法）", () => {
  for (const s of [
    "通用辅助 · 未经本所质量验收",
    "通用辅助审查 · 未经本所质量验收",
    "说明：通用辅助 · 未经本所质量验收 · 草稿待律师复核",
    "通用辅助 · 未经本所质量验收 · 草稿待律师复核",
    "草稿 · 待律师复核",
    "质量说明：通用辅助 · 未经本所质量验收",
  ]) {
    const r = scrubQualityLine(s);
    assert.equal(r.text, "", s);
    assert.ok(r.removed >= 1, s);
  }
});

test("与别的说明连写的只删质量说明那一截，其余原样保留", () => {
  assert.equal(scrubQualityLine("通用辅助 · 未经本所质量验收 · 内部工作稿").text, "内部工作稿");
  assert.equal(scrubQualityLine("内部工作稿 · 通用辅助 · 未经本所质量验收").text, "内部工作稿");
  assert.equal(scrubQualityLine("草稿 · 待律师复核；内部资料，注意保密。").text, "内部资料，注意保密。");
  assert.equal(scrubQualityLine("草稿 · 待律师复核；内部工作稿，不提交法院、不发给对方。").text, "内部工作稿，不提交法院、不发给对方。");
  assert.equal(scrubQualityLine("草稿 · 待律师复核。本报告立场为用人单位，法域为中国大陆。").text, "本报告立场为用人单位，法域为中国大陆。");
  assert.equal(scrubQualityLine("截至 2026-11-10。通用辅助 · 未经本所质量验收").text, "截至 2026-11-10。");
});

test("嵌在句子里的不删（删了句子不通），由交付前检查报出", () => {
  const s = "本方案为草稿 · 待律师复核；不预测仲裁或裁判结果，不替客户决定是否和解。";
  assert.deepEqual(scrubQualityLine(s), { text: s, removed: 0 });
  const c = checkDeliverable("劳动争议应对方案", [{ heading: "一、说明", paragraphs: [s] }]);
  assert.ok(c.issues.some((i) => i.kind === "internal_term" && /质量说明/.test(i.fix)), JSON.stringify(c.issues));
});

test("正常的法律文字一个字不动", () => {
  for (const s of [
    "合同草稿经双方律师复核后签署。",
    "本所律师审查了下列文件；上述文件均为复印件。",
    "手工计算，请复核",
    "该条款属于通用条款，辅助条款另见附件二。",
    "",
    "第一段\n\n第三段",
  ]) assert.deepEqual(scrubQualityLine(s), { text: s, removed: 0 }, s);
});

test("多行文字：只去掉质量说明那一行，原有空行保留", () => {
  assert.equal(scrubQualityLine("内部工作稿\n通用辅助 · 未经本所质量验收\n\n正文第一段").text, "内部工作稿\n\n正文第一段");
});

test("文书各节：段落删空的整段去掉；没有质量说明时返回原数组", () => {
  const sections = [
    { heading: "一、审查范围", paragraphs: ["通用辅助 · 未经本所质量验收", "本意见基于委托人提供的合同文本。"] },
    { heading: "二、结论", paragraphs: ["付款条件对我方不利。"] },
  ];
  const r = scrubQualitySections(sections);
  assert.equal(r.removed, 1);
  assert.deepEqual(r.sections[0]!.paragraphs, ["本意见基于委托人提供的合同文本。"]);
  assert.equal(r.sections[1], sections[1], "没改的节是同一个对象");
  const clean = [{ heading: "一", paragraphs: ["正文"] }];
  assert.equal(scrubQualitySections(clean).sections, clean);
});

test("表格：只剩行名或序号的整行去掉；还有别的内容的只清那一格；表头不删行", () => {
  const rows = [
    ["质量说明", "通用辅助 · 未经本所质量验收"],
    ["草稿状态", "草稿 · 待律师复核"],
    [1, "说明", "通用辅助 · 未经本所质量验收", ""],
    ["立场", "被告（买方）"],
    [2, "管辖", "合同约定苏州仲裁委员会", "通用辅助 · 未经本所质量验收"],
  ];
  const r = scrubQualityRows(rows);
  assert.deepEqual(r.rows, [
    ["立场", "被告（买方）"],
    [2, "管辖", "合同约定苏州仲裁委员会", ""],
  ]);
  assert.equal(r.removed, 4);
  const head = scrubQualityRows([["序号", "核对项", "草稿 · 待律师复核"]], true);
  assert.deepEqual(head.rows, [["序号", "核对项", ""]]);
  const same = [["a", "b"]];
  assert.equal(scrubQualityRows(same).rows, same);
});

test("节内表格与表头一并处理", () => {
  const r = scrubQualitySections([{ heading: "说明", paragraphs: [], table: { columns: ["项目", "内容"], rows: [["质量说明", "通用辅助 · 未经本所质量验收"], ["截止日", "2026-11-10"]] } }]);
  assert.deepEqual(r.sections[0]!.table!.rows, [["截止日", "2026-11-10"]]);
  assert.deepEqual(r.sections[0]!.table!.columns, ["项目", "内容"]);
});

test("打码的号码不当成 Markdown 加粗；真正的加粗照报", () => {
  const masked = checkDeliverable("当事人信息表", [{ heading: "联系方式", paragraphs: ["叶某（身份证尾号 139****3262） 联系电话：138****4173 电子邮箱：ye****@example.com"] }]);
  assert.equal(masked.issues.filter((i) => i.kind === "markdown").length, 0, JSON.stringify(masked.issues));
  const bold = checkDeliverable("备忘录", [{ heading: "一", paragraphs: ["**结论**：付款条件已成就。"] }]);
  assert.equal(bold.issues.filter((i) => i.kind === "markdown").length, 1);
});
