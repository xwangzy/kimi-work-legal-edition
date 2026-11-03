/**
 * V11 路由体检：律师对交付件的要求（deliverableRequest → requiredDeliverables → 结算核对）。
 * - 点名的格式按“要的动作 + 格式词”认，提到材料的格式不算；“不要 / 只要”记为排除；
 * - 文书意图只认两类结构化信号：勾选了 Word 材料 + 改原件的动作；起草 / 出具 + 文书名（后面是清单、表的不算）；
 * - 场景卡自己的任务说明模板不会让表格类方法额外要求 Word（只有律师写的补充要求才会）；
 * - 提示词里新增的“交付要求”一句不被姓名规则误认；
 * - Office 成果扩展名与内容一致（改了名的表格不能当 Word 文书登记）；
 * - 发起确认重新估价时不丢场景卡的主交付物（RunSheet）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MatterTokenizer } from "@zr-legal/tokenizer";
import { createDocx, createXlsx } from "@zr-legal/docx-engine";
import { agentFollowUpPrompt, agentGoalPrompt, deliverablePromptLine, deliverableRequest, deliverableRequestOf, methodPromptLine, requiredDeliverables, verifyOfficeArtifact, type DeliverableRequest } from "../src/executor/executor.ts";
import { SCENARIOS, buildGoal, primaryOutputOf } from "../../../apps/desktop/src/lib/scenarios.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const fmt = (t: string, docx = 0) => deliverableRequest(t, { docxMaterials: docx });

test("点名的格式：要的动作 + 格式词；并列的照样算；提到材料的格式不算", () => {
  const cases: [string, Partial<DeliverableRequest> | null][] = [
    ["审完出 Word", { formats: ["docx"] }],
    ["给我 Excel 表", { formats: ["xlsx"] }],
    ["结论做成excel", { formats: ["xlsx"] }],
    ["定稿后导出PDF发客户", { formats: ["pdf"] }],
    ["请以 Word 格式交付", { formats: ["docx"] }],
    ["要一份 word 版的", { formats: ["docx"] }],
    ["给我 Excel 表和 Word 意见书", { formats: ["docx", "xlsx"] }],
    ["出 Word 意见书、Excel 问题清单", { formats: ["docx", "xlsx"] }],
    ["转成 PDF", { formats: ["pdf"] }],
    ["把结论改成 Excel", { formats: ["xlsx"] }],
    ["生成电子表格", { formats: ["xlsx"] }],
  ];
  for (const [t, want] of cases) {
    const r = fmt(t);
    assert.ok(r, t);
    assert.deepEqual(r.formats, want!.formats, t);
    assert.deepEqual(r.not, [], t);
  }
  // 提到的是材料的格式，不是要的交付格式
  for (const t of ["按客户意见看看上传的Word合同有什么问题", "用Excel里的数据核对一下金额", "附件PDF是判决书，请分析上诉理由", "这份 Word 文件里的条款有效吗", "wordpress 网站的隐私政策合规吗", "我认为Word版本的第三条有问题", "作为PDF附件的判决书写错了吗"]) {
    assert.deepEqual(fmt(t)?.formats ?? [], [], t);
  }
});

test("不要 / 只要：记为排除；点名要的格式不会同时被排除", () => {
  assert.deepEqual(fmt("不要 Excel，出 Word"), { formats: ["docx"], not: ["xlsx"], document: null });
  assert.deepEqual(fmt("无需Word，只要一张 Excel 表"), { formats: ["xlsx"], not: ["docx", "pdf"], document: null });
  assert.deepEqual(fmt("只要 PDF"), { formats: ["pdf"], not: ["xlsx"], document: null }, "PDF 由 Word 导出：只要 PDF 不排除 Word");
});

test("文书意图：勾选了 Word 材料 + 改原件的动作 → revise；审查、比对成果的说法不算", () => {
  for (const t of ["按客户意见修改这份合同", "付款改为 3-4-3 分期，验收期改成15个工作日", "删去第十二条", "按我方意见把回稿改好", "对方改了几处，按我方意见改回去", "请出修订稿和清洁稿"]) {
    assert.equal(fmt(t, 1)?.document, "revise", t);
    assert.notEqual(fmt(t, 0)?.document, "revise", `没有 Word 材料时不认改原件：${t}`);
  }
  for (const t of ["对方改了哪些？帮我看看", "请审查合同并给出修改建议", "列出修改情况", "请比对我方上一稿与对方回稿，并只对改动部分重新审查"]) {
    assert.equal(fmt(t, 2)?.document ?? null, null, t);
  }
});

test("文书意图：起草 / 出具 + 文书名 → draft；后面是清单、表、目录的不算；只问问题不加要求", () => {
  for (const t of ["帮我起草一份股权转让协议", "起草起诉状，违约金分段计算", "出具法律意见书", "请写一封律师函给对方", "整理一份尽调报告（内部稿）", "草拟股东会决议", "审完出一份审查意见书"]) {
    assert.equal(fmt(t)?.document, "draft", t);
  }
  for (const t of ["做一份尽调清单", "起草合同审查问题清单", "写一份证据目录", "股权转让需要其他股东同意吗？", "这个案子的诉讼时效过了没有", "测算逾期付款违约金"]) {
    assert.equal(fmt(t)?.document ?? null, null, t);
  }
});

test("要核对的交付件：方法主交付物 + 律师点名的格式 + 文书意图 + 追问继承；“不要 / 只要”去掉方法的那一份", () => {
  const R = (t: string, docx = 0) => fmt(t, docx);
  assert.deepEqual(requiredDeliverables("变更清单.xlsx", R("回稿意见给我 Word")), ["变更清单.xlsx", "Word 文书.docx"], "表格类方法 + 律师点名 Word：两样都要");
  assert.deepEqual(requiredDeliverables("计算明细.xlsx", R("起草起诉状，违约金分段计算")), ["计算明细.xlsx", "Word 文书.docx"], "金额测算卡 + 补充要求里的起诉状");
  assert.deepEqual(requiredDeliverables("审查意见书（内部稿）.docx", R("问题清单给我 Excel")), ["审查意见书（内部稿）.docx", "Excel 表.xlsx"], "点名的格式是附加要求，方法的意见书照常要");
  assert.deepEqual(requiredDeliverables("审查意见书（内部稿）.docx", R("不要Word，只要 Excel 表")), ["Excel 表.xlsx"], "律师说不要 Word：方法的意见书不再要求");
  assert.deepEqual(requiredDeliverables("民事起诉状（草稿）.docx", R("出 Word")), ["民事起诉状（草稿）.docx"], "同一种格式只核对一次，用方法的叫法");
  assert.deepEqual(requiredDeliverables(null, R("帮我起草一份股权转让协议")), ["Word 文书.docx"], "自由描述没加载方法：照样要 Word");
  assert.deepEqual(requiredDeliverables(null, R("定稿后要 PDF")), ["Word 文书.docx"], "PDF 由 Word 导出");
  assert.deepEqual(requiredDeliverables(null, null, "合同草稿.docx"), ["合同草稿.docx"], "追问继承上一轮没交出的");
  assert.deepEqual(requiredDeliverables(null, null), [], "只问问题的任务不核对（与第 34 批一致）");
  assert.deepEqual(requiredDeliverables("审查要点草稿（待你审定）", null), [], "主交付物不是 Word 或 Excel 的方法照旧不核对");
  assert.deepEqual(deliverableRequestOf({ formats: ["docx", "rtf"], not: [], document: "x" }), { formats: ["docx"], not: [], document: null }, "快照里认不出的值丢掉");
  assert.equal(deliverableRequestOf("docx"), null);
});

test("场景卡自己的任务说明模板：表格类方法不会因为模板文字额外要求 Word（只有律师写的补充要求会）", () => {
  const manifest = JSON.parse(readFileSync(repo("content/skills/dist/skills.manifest.json"), "utf8")) as { skills: { id: string; primary_output?: string }[] };
  const bad: string[] = [];
  for (const c of SCENARIOS) {
    if (c.scenario !== "a1.agent_task" || !c.skill) continue;
    const primary = primaryOutputOf(c, {}) ?? manifest.skills.find((s) => s.id === c.skill)?.primary_output ?? null;
    // 必填字段填上占位文字（不含格式词与改写动作），可选字段留空
    const values = Object.fromEntries(c.fields.map((f) => [f.key, f.options?.[0] ?? "甲公司"]));
    const goal = buildGoal(c, values, "");
    const req = deliverableRequest(goal, { docxMaterials: c.minMaterials });
    const need = requiredDeliverables(primary, req);
    const expect = primary && /\.(docx|xlsx)$/i.test(primary) ? [primary] : [];
    if (JSON.stringify(need) !== JSON.stringify(expect)) bad.push(`${c.id}：${goal} → ${JSON.stringify(need)}（应为 ${JSON.stringify(expect)}）`);
  }
  assert.deepEqual(bad, []);
});

test("“交付要求”一句写明格式、工具与核对；与方法、追问拼在一起不被姓名规则误认", () => {
  const all: DeliverableRequest = { formats: ["docx", "xlsx", "pdf"], not: ["xlsx"], document: "draft" };
  const line = deliverablePromptLine(all, "合同草稿.docx");
  assert.match(line, /^【交付要求】律师点名要的交付格式：Word 文书（用 docx\.render_report 生成/);
  assert.match(line, /上一轮没有交出《合同草稿》，本轮须补出/);
  assert.match(line, /没有交出的不记完成。\n$/);
  assert.equal(deliverablePromptLine(null), "");
  assert.match(deliverablePromptLine({ formats: [], not: [], document: "revise" }), /docx\.revise 出的修订稿与清洁稿/);
  const texts = [
    line,
    deliverablePromptLine({ formats: [], not: [], document: "revise" }),
    deliverablePromptLine(null, "尽调清单.xlsx"),
    agentFollowUpPrompt("把协议补出来", `${methodPromptLine(null, null)}${line}`, false),
    agentGoalPrompt({ stance: "受让方", jurisdiction: "内地民商事", asOf: "2026-11-03", facts: "", goal: "起草股权转让协议", methodLine: `${methodPromptLine("redraft-review", null, "变更清单.xlsx")}${line}`, rulesBlock: "", prefsLine: "" }),
  ];
  for (const t of texts) {
    const hits = new MatterTokenizer({ matterKey: randomBytes(32) }).tokenize(t).entries.filter((e) => e.category === "person").map((e) => e.value);
    assert.deepEqual(hits, [], `被认成姓名：${hits.join("、")}`);
  }
});

test("Office 成果扩展名与内容一致：改了名的表格不能当 Word 文书登记，真文书照常放行", () => {
  const docx = createDocx("意见书", [{ heading: "一", paragraphs: ["正文"] }]);
  const xlsx = createXlsx([{ name: "表", rows: [["项目"], ["甲"]] }]);
  assert.doesNotThrow(() => verifyOfficeArtifact("意见书.docx", () => docx));
  assert.doesNotThrow(() => verifyOfficeArtifact("清单.xlsx", () => xlsx));
  assert.throws(() => verifyOfficeArtifact("合同.docx", () => xlsx), /不是能打开的 Office 文件/);
  assert.throws(() => verifyOfficeArtifact("清单.xlsx", () => docx), /不是能打开的 Office 文件/);
  assert.throws(() => verifyOfficeArtifact("合同.docx", () => Buffer.from("# 合同\n第一条", "utf8")), /ZIP|DOCX/, "不是压缩包的照旧拒绝");
});

test("发起确认重新估价（记录客户同意、核对疑似姓名之后）沿用场景卡的主交付物（RunSheet）", () => {
  const src = readFileSync(repo("apps/desktop/src/components/RunSheet.tsx"), "utf8");
  const calls = src.split("\n").filter((l) => /\bprepareStart\(/.test(l) && !/function prepareStart/.test(l));
  assert.ok(calls.length >= 2, "两处重新估价");
  for (const c of calls) assert.match(c, /startOptionsOf\(cur\)/, `重新估价用同一份发起选项：${c}`);
  const fn = /export function startOptionsOf[\s\S]*?\n}/.exec(src)?.[0] ?? "";
  for (const k of ["skill", "label", "skillArgs", "reviewRules", "primaryOutput", "docNames"]) assert.match(fn, new RegExp(`p\\.${k}`), `带上 ${k}`);
});

test("V11 D1 模型端点未配置：失败说明写明要先配置，不写“暂时连不上 / 稍后重新运行”", async () => {
  const { agentFailureText } = await import("../src/executor/executor.ts");
  for (const e of ["模型端点未配置：模型通道未配置（请先在设置里配置模型端点；不会切换到其他端点，重试不会成功）", "503 模型通道未配置"]) {
    const t = agentFailureText("host_reported_failure", e);
    assert.match(t, /还没有配置 AI 模型端点/, e);
    assert.doesNotMatch(t, /暂时连不上|稍后/, e);
  }
  assert.match(agentFailureText("host_reported_failure", "502 模型通道不可达（已排队或稍后重试）"), /暂时连不上/, "真正的暂时故障照旧");
});
