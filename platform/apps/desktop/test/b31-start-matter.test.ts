// 第 31 批：开始面板默认事项不抢走律师在首页选中的事项（真实走查：选“陈思远”事项、点意图建议后面板挂到了示例事项，并勾选了示例事项的材料）
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { docArgsFor, lineMismatchText, matterLine, NEXT_STEPS, pickMatterForCard, primaryOutputOf, SCENARIOS, sideOptionFor } from "../src/lib/scenarios.ts";

const card = (id: string) => SCENARIOS.find((c) => c.id === id)!;
const sample = { matter_id: "m_sample", stance: "原告", created_at: "2026-10-29T09:15:00Z" };
const other = { matter_id: "m_other", stance: "其他", created_at: "2026-10-01T08:00:00Z" };
const labor = { matter_id: "m_labor", stance: "申请人（劳动者）", created_at: "2026-10-01T08:00:00Z" };

test("当前事项看不出业务线时照用当前事项，不被最近的诉讼事项（示例事项）抢走", () => {
  assert.equal(pickMatterForCard(card("labor-arb-application"), [sample, other], "m_other"), "m_other");
  assert.equal(pickMatterForCard(card("contract-review"), [sample, other], "m_other"), "m_other");
  // 它本来也不提醒“不一致”，两处口径一致
  assert.equal(lineMismatchText(card("labor-arb-application"), other), null);
  // 当前事项业务线不一致时仍按 Z3 #1 挑一致的（不变）
  assert.equal(pickMatterForCard(card("contract-review"), [sample, other], "m_sample"), "m_other");
});

test("立场带括注按括注前的词判断业务线", () => {
  assert.equal(matterLine(labor), "litigation");
  assert.equal(matterLine({ stance: "原告（反诉被告）" }), "litigation");
  assert.equal(matterLine({ stance: "承租方(餐饮)" }), "transactional");
  assert.equal(pickMatterForCard(card("labor-arb-application"), [sample, labor], "m_labor"), "m_labor");
});

// ─── 场景卡的实际主交付物（卡上 primary，没写取方法 outputs 第一项）必须是这张卡“你得到什么”里的一项 ───
// 第 31 批：两张劳动仲裁答辩书卡、解除前评估卡没写 primary，发给助手的提示词把主交付物说成《劳动仲裁申请书》《劳动争议应对方案》
function frontmatterList(text: string, key: string): string[] {
  const m = new RegExp(`^\\s{2}${key}:\\s*\\[(.*)\\]\\s*$`, "m").exec(text);
  return m ? m[1]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
}
/** “争点—证据矩阵.xlsx（要件、证据…）”→“争点—证据矩阵.xlsx”：卡上文件名后的括注只是说明 */
const fileOf = (g: string) => g.replace(/\.(docx|xlsx)（.*$/, ".$1");

test("每张卡的实际主交付物都在卡片“你得到什么”里（只要卡上列了方法的交付物）", () => {
  const skillsDir = fileURLToPath(new URL("../../../content/skills/", import.meta.url));
  const bad: string[] = [];
  for (const c of SCENARIOS) {
    if (!c.skill) continue;
    const outs = frontmatterList(readFileSync(join(skillsDir, c.skill, "SKILL.md"), "utf8"), "outputs");
    const primary = c.primary ?? outs[0]!;
    const gets = (c.gets ?? []).map(String).map(fileOf);
    if (gets.some((g) => outs.includes(g)) && !gets.includes(primary)) bad.push(`${c.id}：主交付物 ${primary}，卡上是 ${gets.join("、")}`);
  }
  assert.deepEqual(bad, []);
  assert.equal(card("labor-arb-defense").primary, "劳动仲裁答辩书（草稿）.docx");
  assert.equal(card("labor-arb-defense-lit").primary, "劳动仲裁答辩书（草稿）.docx");
  assert.equal(card("labor-termination").primary, "解除风险评估.docx");
});

test("“我方是”按事项立场预选：立场或括注里的词与选项（或“原告 / 申请人”的一半）相同才预选", () => {
  const labor = ["劳动者", "用人单位"];
  const lit = ["原告 / 申请人", "被告 / 被申请人", "第三人"];
  assert.equal(sideOptionFor(labor, "劳动者"), "劳动者");
  assert.equal(sideOptionFor(labor, "申请人（劳动者）"), "劳动者");
  assert.equal(sideOptionFor(lit, "原告"), "原告 / 申请人");
  assert.equal(sideOptionFor(lit, "被申请人"), "被告 / 被申请人");
  assert.equal(sideOptionFor(lit, "申请人（劳动者）"), "原告 / 申请人");
  // 对不上的不猜
  assert.equal(sideOptionFor(labor, "申请人"), null);
  assert.equal(sideOptionFor(lit, "受让方"), null);
  assert.equal(sideOptionFor(lit, "其他"), null);
  assert.equal(sideOptionFor(lit, ""), null);
  assert.equal(sideOptionFor(undefined, "原告"), null);
});

test("意图建议（第 31 批，审查 B-06/B-07/B-15/B-16）：律师常用说法引到对的卡；原有用例不变", async () => {
  const { suggestScenario } = await import("../src/lib/scenarios.ts");
  const cases: [string, string][] = [
    ["收到员工的劳动仲裁申请书", "labor-arb-defense"],
    ["收到劳动仲裁申请书，帮我写答辩书", "labor-arb-defense-lit"],
    ["员工告我们了，写个答辩", "labor-arb-defense"],
    ["申请劳动仲裁", "labor-apply"],
    ["员工被辞退，要申请仲裁", "labor-apply"],
    ["解除劳动合同前的风险", "labor-termination"],
    ["给员工发解除通知", "labor-termination"],
    ["写尽职调查报告", "dd-findings"],
    ["执行时效过了吗", "enforcement"],
    ["帮我改一下起诉状", "doc-revise"],
    // 原有的不变
    ["公司以旷工为由把陈思远辞退了，帮他起草一份劳动仲裁申请书，要求违法解除赔偿金和拖欠的工资", "labor-arb-application"],
    ["员工申请劳动仲裁怎么应对", "labor-response"],
    ["替员工申请仲裁", "labor-apply"],
    ["公司收到仲裁申请书了", "suit-received"],
    ["这个合同纠纷的管辖法院和诉讼时效核查一下", "procedure"],
    ["帮我写一份起诉状", "pleading"],
    ["审查这份采购合同", "contract-review"],
  ];
  for (const [g, id] of cases) assert.equal(suggestScenario(g)?.id, id, g);
  // 劳动仲裁时效不引到按民法典诉讼时效写的“管辖与时效核查”
  assert.notEqual(suggestScenario("劳动仲裁时效过了吗")?.id, "procedure");
});

test("主交付物随律师选的字段变（审查 B-04、B-05）：致对方版、书面决定不出会议通知；值都在方法 outputs 里", () => {
  assert.equal(primaryOutputOf(card("redline-notes"), { audience: "致对方" }), "修订说明（致对方）.docx");
  assert.equal(primaryOutputOf(card("redline-notes"), { audience: "致客户" }), undefined, "致客户用方法 outputs 第一项");
  assert.equal(primaryOutputOf(card("corporate-resolutions"), { meeting: "全体股东书面决定" }), "决议（草稿）.docx");
  assert.equal(primaryOutputOf(card("corporate-resolutions"), { meeting: "一人公司股东决定" }), "决议（草稿）.docx");
  assert.equal(primaryOutputOf(card("corporate-resolutions"), { meeting: "临时股东会" }), undefined);
  assert.equal(primaryOutputOf(card("dd-findings"), {}), "尽调报告（内部稿）.docx", "没有 primaryBy 时用 primary");
  const skillsDir = fileURLToPath(new URL("../../../content/skills/", import.meta.url));
  for (const c of SCENARIOS.filter((x) => x.primaryBy)) {
    const outs = frontmatterList(readFileSync(join(skillsDir, c.skill!, "SKILL.md"), "utf8"), "outputs");
    const field = c.fields.find((f) => f.key === c.primaryBy!.field);
    assert.ok(field, `${c.id}：primaryBy 的字段不存在`);
    for (const [opt, out] of Object.entries(c.primaryBy!.map)) {
      assert.ok(field!.options?.includes(opt), `${c.id}：${opt} 不是字段选项`);
      assert.ok(outs.includes(out), `${c.id}：${out} 不在方法 outputs 里`);
    }
  }
});

test("按勾选的材料补方法参数（审查 B-13、B-21）：回稿重审传上一稿 / 回稿，文稿体检只核一份时传文件名", () => {
  assert.deepEqual(docArgsFor(card("redraft"), ["采购合同（我方第二稿）.docx", "采购合同（对方回稿）.docx"]), { baseline: "采购合同（我方第二稿）.docx", current: "采购合同（对方回稿）.docx" });
  assert.deepEqual(docArgsFor(card("redraft"), ["只有一份.docx"]), {});
  assert.deepEqual(docArgsFor(card("citation-audit"), ["代理词.docx"]), { document: "代理词.docx" });
  assert.deepEqual(docArgsFor(card("citation-audit"), ["a.docx", "b.docx"]), {});
  assert.deepEqual(docArgsFor(card("contract-review"), ["a.docx"]), {});
});

test("“接着做”（审查 B-18）：诉讼线的起诉状、律师函之后指向诉讼线的进展汇报卡", () => {
  assert.ok(NEXT_STEPS.pleading!.includes("case-report-lit") && !NEXT_STEPS.pleading!.includes("case-report"));
  assert.deepEqual(NEXT_STEPS["demand-lit"], ["case-report-lit"]);
  for (const [from, list] of Object.entries(NEXT_STEPS)) for (const to of list) assert.ok(SCENARIOS.some((c) => c.id === to), `${from} → ${to} 不存在`);
});

test("卡片“你给什么”和步骤不再要求“已确认的事实”（审查 B-10、B-19，D-154/D-155）", () => {
  for (const c of SCENARIOS) {
    const text = [c.gives, ...(c.steps ?? [])].join("；");
    assert.doesNotMatch(text, /已确认的事实|只用你确认|只用你在事实表里确认/, c.id);
  }
});

test("导入失败提示（第 31 批异常走查）：截断的 Word 不再显示“ZIP/DOCX”", async () => {
  const { importFailText } = await import("../src/lib/errors.ts");
  const t = importFailText("损坏的合同.docx", "不是有效的 ZIP/DOCX 文件");
  assert.match(t, /^损坏的合同\.docx 没有添加：这个文件已损坏或不完整/);
  assert.doesNotMatch(t, /ZIP/);
  // 其他中文原因照写（不变）
  assert.equal(importFailText("a.docx", "超过 200MB 上限"), "a.docx 没有添加：超过 200MB 上限");
});

test("完成卡只列每个同名文件的最新一版（第 31 批真实走查：申请书、证据目录各两行一模一样）", async () => {
  const { currentFiles } = await import("../src/lib/run-pane.ts");
  const a = [
    { artifact_version_id: "1", kind: "agent_report", filename: "劳动仲裁申请书.docx", version: 1 },
    { artifact_version_id: "2", kind: "agent_table", filename: "证据目录.xlsx", version: 1 },
    { artifact_version_id: "3", kind: "agent_table", filename: "提交前核对清单.xlsx", version: 1 },
    { artifact_version_id: "4", kind: "agent_table", filename: "证据目录.xlsx", version: 2 },
    { artifact_version_id: "5", kind: "agent_report", filename: "劳动仲裁申请书.docx", version: 2 },
    { artifact_version_id: "6", kind: "revision_draft", filename: "劳动仲裁申请书.docx", version: 1 },
  ];
  const r = currentFiles(a);
  assert.deepEqual(r.current.map((x) => x.artifact_version_id), ["5", "4", "3", "6"], "按首次出现的顺序，取最新版；类型不同的同名文件分开");
  assert.equal(r.older, 2);
  assert.deepEqual(currentFiles([]), { current: [], older: 0 });
});
