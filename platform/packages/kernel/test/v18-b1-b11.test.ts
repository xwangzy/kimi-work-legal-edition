/**
 * V18 首轮 B1（界面用语不进成果）与 B11（出文书的二、三级标题）在内核侧的纯函数部分：
 * 交付前检查的界面用语规则（正反用例）、按层级判断节标题序号、事实对照说明新旧两种写法都认、改稿后按样式还原三级标题。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, readZipText } from "@zr-legal/docx-engine";
import { checkDeliverable, headingNumberIssues } from "../src/services/deliverable-check.ts";
import { FACT_NOTE, FACT_NOTE_LEGACY_PREFIX, factSection, hasFactSection, isFactNote, stripFactSection } from "../src/services/fact-refs.ts";
import { sectionsOfDocx } from "../src/tools/tools/edit-draft.ts";
import { agentGoalPrompt, DIRECT_START_LINE, PLAN_FIRST_LINE } from "../src/executor/executor.ts";

const uiHits = (title: string, paragraphs: string[]) => checkDeliverable(title, [{ heading: "一、意见", paragraphs }]).issues.filter((i) => i.kind === "internal_term" && /产品界面/.test(i.fix)).map((i) => i.text);

test("B1 界面用语：审查工作台、风险卡序号、工作台上的操作、事实时间线上的操作、任务页、开始面板——命中即报，改法指向律师的说法", () => {
  const hits = uiHits("审查意见书（内部稿）-采购合同", [
    "律师在审查工作台逐项接受后，可在工作台生成修订稿与清洁稿。",
    "付款节点不明确（风险卡 12）。",
    "风险卡序号 3、5 已合并处理。",
    "已提交到事实时间线，请到事实时间线逐条确认。",
    "可在任务页查看，也可在开始面板重新选择。",
    "在工作台处理完风险卡后再生成。",
    "已提交10张风险卡，锚点均已定位；本意见与问题清单对应风险卡。",
    "合同事实已另行提交事实时间线。",
  ]);
  for (const w of ["审查工作台", "可在工作台生成", "风险卡 12", "风险卡序号", "提交到事实时间线", "到事实时间线", "任务页", "开始面板", "工作台处理完风险卡", "提交10张风险卡", "对应风险卡", "另行提交事实时间线"]) assert.ok(hits.some((h) => h.includes(w) || w.includes(h)), `应报“${w}”：${hits.join("｜")}`);
  const fix = checkDeliverable("x", [{ heading: "", paragraphs: ["见审查工作台"] }]).issues.find((i) => i.text === "审查工作台")!.fix;
  assert.match(fix, /问题序号、事实清单/);
  assert.match(fix, /写在给律师的答复里/);
  // 表格（问题清单的表头）同样报
  const t = checkDeliverable("问题清单-采购合同", [{ heading: "", paragraphs: [], table: { columns: ["序号", "条款", "风险卡序号"], rows: [["1", "第3条", "1"]] } }], { table: true });
  assert.ok(t.issues.some((i) => i.text === "风险卡序号"));
});

test("B1 界面用语：合同条文里单独的“工作台”、文件名《事实时间线》、问题序号、普通的“风险”不报", () => {
  assert.deepEqual(
    uiHits("技术服务合同", [
      "乙方应向甲方提供运维工作台及其操作手册，甲方人员可在工作台上提交工单。",
      "乙方在工作台处理工单的响应时间不超过2小时。",
      "工作台的账号由甲方管理员分配。",
    ]),
    [],
  );
  assert.deepEqual(uiHits("案情分析备忘录", ["各项事实见《事实时间线》（另附）。", "事实时间线-某某纠纷 已按日期排序。", "本节按问题序号 1～5 列出。", "该条款风险较高，建议修改（问题序号 7）。", "风险卡片式管理制度（第 3 条）。"]), []);
  assert.deepEqual(uiHits("事实时间线-某某纠纷", ["按日期排列。"]), [], "成果标题里的“事实时间线-”不报");
});

test("B11 节标题序号：二级只按（一）（二）计数、写成“一、”的二级不与大节撞号；三级不参与计数；未标层级的旧写法照旧", () => {
  const ok = headingNumberIssues([
    { heading: "一、基本事实" },
    { heading: "（一）合同签订", level: 2 },
    { heading: "1. 签约过程", level: 3 },
    { heading: "1. 签约主体", level: 3 },
    { heading: "（二）合同履行", level: 2 },
    { heading: "二、分析" },
    { heading: "（一）付款条件", level: 2 },
    { heading: "一、关于付款条件是否成就", level: 2 },
  ]);
  assert.deepEqual(ok, []);
  // 二级小节跳号照报
  const skip = headingNumberIssues([{ heading: "一、事实" }, { heading: "（一）甲", level: 2 }, { heading: "（三）丙", level: 2 }]);
  assert.equal(skip.length, 1);
  // 旧写法（不标层级、小标题也写成一节）照旧报重复
  const old = headingNumberIssues([{ heading: "一、事实" }, { heading: "二、争点" }, { heading: "二、争点（续）" }]);
  assert.equal(old.length, 1);
  assert.match(old[0]!.fix, /序号重复/);
});

test("B11 改稿后按样式还原：三级标题开一节并标 level 3，二级照旧（不标层级）", () => {
  const buf = createDocx("研究备忘录-优先购买权", [
    { heading: "一、问题", paragraphs: ["甲"] },
    { heading: "（一）子问题", level: 2, paragraphs: ["乙"] },
    { heading: "1. 要件", level: 3, paragraphs: ["丙"] },
  ]);
  const r = sectionsOfDocx(buf);
  assert.deepEqual(r.sections.map((s) => [s.heading, s.level ?? null, s.paragraphs]), [
    ["一、问题", null, ["甲"]],
    ["（一）子问题", null, ["乙"]],
    ["1. 要件", 3, ["丙"]],
  ]);
});

test("B1 事实对照说明：新写法不提“系统”“页”；新旧两种开头都认作系统附的那一节，旧文书改稿时照样换掉", () => {
  assert.equal(/系统|页|自动/.test(FACT_NOTE), false, FACT_NOTE);
  assert.ok(isFactNote(FACT_NOTE));
  assert.ok(isFactNote(`${FACT_NOTE_LEGACY_PREFIX}，序号与事项“事实”页一致；正文改动后随之更新。“待确认”的事实尚未经律师确认。）`));
  assert.equal(isFactNote("（本节列出了一些事实）"), false);
  const rows = [["事实 1", "双方签订合同", "2026-03-01", "合同.docx", "已确认"]];
  const legacy = factSection(rows, 0);
  legacy.paragraphs = [`${FACT_NOTE_LEGACY_PREFIX}，序号与事项“事实”页一致；正文改动后随之更新。“待确认”的事实尚未经律师确认。）`];
  for (const sec of [factSection(rows, 0), legacy]) {
    const xml = readZipText(createDocx("案情分析备忘录", [{ heading: "一、事实", paragraphs: ["双方签订合同（事实 1）。"] }, sec]), "word/document.xml")!;
    assert.ok(hasFactSection(xml));
    const stripped = stripFactSection(xml);
    assert.equal(stripped.includes("双方签订合同（事实 1）。"), true);
    assert.equal(/事实对照|本节/.test(stripped), false);
  }
  // 超出上限的说明同样是律师的话
  assert.match(factSection(rows, 3).paragraphs[0]!, /^（本节列出正文引用的各项事实及其出处，供核对；“待确认”的事实尚未经律师确认；另有 3 条超出本表上限未列。）$/);
});

test("A3 任务说明里的做法：先看计划 / 直接开始各写一句；不给时不写", () => {
  const base = { stance: "买方", jurisdiction: "内地民商事", asOf: "2026-11-13", facts: "", goal: "审查合同", methodLine: "", rulesBlock: "", prefsLine: "" };
  assert.ok(agentGoalPrompt({ ...base, planFirst: true }).includes(PLAN_FIRST_LINE));
  const direct = agentGoalPrompt({ ...base, planFirst: false });
  assert.ok(direct.includes(DIRECT_START_LINE));
  assert.match(DIRECT_START_LINE, /不进入计划模式/);
  const none = agentGoalPrompt(base);
  assert.equal(none.includes("【做法】"), false);
  // 工作方式里提到界面名称时写明不进交付文件
  assert.match(none, /是产品界面上的名称，不写进交付文件/);
});

test("B1 界面用语：把产品里的事实清单叫成“事实时间线”并说它“无律师确认事实”——报（V18 第 43 批真实回归 m04 备忘录）", async () => {
  const { UI_TERM_RE } = await import("../src/services/deliverable-check.ts");
  const hit = (t: string) => (UI_TERM_RE.lastIndex = 0, UI_TERM_RE.test(t));
  assert.equal(hit("事实时间线原无律师确认事实，本稿据材料记载分析并统一标注未确认。"), true);
  assert.equal(hit("事实时间线尚无经律师确认的事实"), true);
  assert.equal(hit("本案事实时间线清晰，付款节点无争议。"), false, "一般意义上的“事实时间线”不报");
  assert.equal(hit("各项事实见《事实时间线》（另附）。"), false);
});
