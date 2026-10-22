/**
 * 意图建议（复核 B3-B24）：取命中最具体的场景；模板不支持的文书不引到起诉状模板。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestScenario } from "../src/lib/scenarios.ts";

test("意图建议：最具体者优先；答辩状、仲裁申请书不引到起诉状模板", () => {
  assert.equal(suggestScenario("帮我起草一份民事起诉状")?.id, "pleading");
  assert.equal(suggestScenario("核对起诉状里的引用是否有效")?.id, "citation-audit", "引用核对有了自己的卡（v9.4 S1 §6.1 第 1 项）");
  assert.equal(suggestScenario("帮我检索类案"), null, "案例库未开通：不再把“类案”引到法规研究（v9.4）");
  assert.equal(suggestScenario("做一份尽调清单")?.id, "dd-list", "尽调有了自己的方法（v9.4）");
  assert.equal(suggestScenario("整理尽调发现写报告")?.id, "dd-findings");
  assert.equal(suggestScenario("帮我起草一份买卖合同")?.id, "contract-draft");
  assert.equal(suggestScenario("这个案子诉讼时效过了吗")?.id, "procedure");
  assert.equal(suggestScenario("准备辞退一名员工有什么风险")?.id, "labor-termination");
  assert.equal(suggestScenario("公司收到起诉状了怎么办")?.id, "suit-received");
  assert.equal(suggestScenario("对方回稿改了哪些")?.id, "redraft");
  assert.equal(suggestScenario("写一份修订说明给客户")?.id, "redline-notes");
  assert.equal(suggestScenario("帮我写一份答辩状")?.id, "defense", "答辩状有了自己的卡（v9.3 诉讼线文书），不引到起诉状");
  assert.equal(suggestScenario("对方证据怎么写质证意见")?.id, "cross-exam");
  assert.equal(suggestScenario("庭后写一份代理词")?.id, "agency");
  assert.equal(suggestScenario("帮我分析一下案情，这个案子怎么打")?.id, "case-analysis", "Z3 #28");
  assert.equal(suggestScenario("梳理争点和补证")?.id, "issues", "说争点仍引到争点与证据分析");
  // 答辩状模板只做民商事一审答辩：二审、仲裁、行政、劳动答辩不引过去（复核 RB16B-16）
  for (const g of ["帮我写二审答辩状", "被上诉人答辩状怎么写", "准备仲裁答辩", "写一份行政诉讼答辩状"]) assert.notEqual(suggestScenario(g)?.id, "defense", g);
  assert.equal(suggestScenario("准备仲裁申请书")?.id, "arbitration-app", "v9.4 第 21 批：仲裁申请书有了自己的方法");
  assert.equal(suggestScenario("员工申请劳动仲裁怎么应对")?.id, "labor-response");
  assert.equal(suggestScenario("审查这份采购合同的风险")?.id, "contract-review");
});

test("示例事项说明按业务线（Z3 #27）", async () => {
  const { sampleBannerText } = await import("../src/lib/scenarios.ts");
  assert.match(sampleBannerText({ stance: "原告" }), /证据目录.*案情分析与诉讼策略/);
  assert.ok([...sampleBannerText({ stance: "原告" })].length <= 75, "示例横幅一行说完（v9.4 U1 §3.3）");
  assert.match(sampleBannerText({ stance: "受让方" }), /审查意见/);
});

test("意图建议不把审合同、劳动争议引到案情分析（余项续复核 RC-B-12）", async () => {
  const { suggestScenario } = await import("../src/lib/scenarios.ts");
  assert.notEqual(suggestScenario("审查这份合同的诉讼风险")?.id, "case-analysis");
  assert.notEqual(suggestScenario("这份合同签了以后有什么诉讼风险")?.id, "case-analysis");
  assert.equal(suggestScenario("员工申请劳动仲裁，帮我分析案情")?.id, "labor-response");
  assert.equal(suggestScenario("这个劳动仲裁案子风险大吗")?.id, "labor-response");
  assert.equal(suggestScenario("帮我分析一下这个买卖合同纠纷的案情")?.id, "case-analysis");
  assert.equal(suggestScenario("被起诉了，风险在哪里")?.id, "case-analysis");
});

test("示例事项说明按整理任务状态写；我方地位分清拟起诉与可能被诉（余项续复核 RC-B-13）", async () => {
  const { sampleBannerText, SCENARIOS } = await import("../src/lib/scenarios.ts");
  const lit = { stance: "原告" };
  assert.match(sampleBannerText(lit, "done"), /已在这台电脑上按规则整理出/);
  assert.match(sampleBannerText(lit, "running"), /正在这台电脑上按规则整理/);
  assert.match(sampleBannerText(lit, "failed"), /整理还没有完成/);
  assert.doesNotMatch(sampleBannerText(lit, null), /已在这台电脑上按规则整理出/);
  const side = SCENARIOS.find((c) => c.id === "case-analysis")!.fields!.find((f) => f.key === "side")!;
  assert.ok(side.options!.includes("尚未起诉（我方拟起诉）") && side.options!.includes("尚未起诉（对方可能起诉）"));
});

test("v9.4 名实相符：每张卡的方法模板都存在；卡上固定的方法参数都是该模板声明的参数", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { SCENARIOS } = await import("../src/lib/scenarios.ts");
  const root = fileURLToPath(new URL("../../../content/skills/", import.meta.url));
  for (const c of SCENARIOS) {
    if (!c.skill) continue;
    const file = `${root}${c.skill}/SKILL.md`;
    assert.ok(existsSync(file), `${c.id} → ${c.skill} 没有 SKILL.md`);
    const declared = (/^arguments:\s*\[([^\]]*)\]/m.exec(readFileSync(file, "utf8"))?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    for (const k of Object.keys(c.args ?? {})) assert.ok(declared.includes(k), `${c.id}：固定参数 ${k} 不在 ${c.skill} 的 arguments（${declared.join("、")}）里`);
    // 律师填写的字段不能与固定参数同名，否则会把固定的模式或立场覆盖掉（复核 Q1-10）
    for (const f of c.fields) assert.ok(!(f.key in (c.args ?? {})), `${c.id}：字段 ${f.key} 与固定参数同名`);
  }
});

test("v9.4 第 21 批：原“即将推出”的八项有了卡，意图建议能命中，且不抢已有卡", async () => {
  const { suggestScenario } = await import("../src/lib/scenarios.ts");
  const cases: [string, string][] = [
    ["帮我写一份上诉状", "appeal"],
    ["不服一审判决，准备上诉", "appeal"],
    ["帮我起草仲裁申请书", "arbitration-app"],
    ["准备开庭，列个庭审提纲", "hearing-outline"],
    ["起诉前先申请财产保全", "preservation"],
    ["判决生效了对方不付钱，申请强制执行", "enforcement"],
    ["起草一份增资的股东会决议", "corporate-resolutions"],
    ["董事会通知怎么写", "corporate-resolutions"],
    ["把股权转让协议的先决条件整理成交割清单", "closing-checklist"],
    ["审查一下公司的员工手册", "policy-review"],
    ["这个规章制度没走民主程序有什么问题", "policy-review"],
  ];
  for (const [g, id] of cases) assert.equal(suggestScenario(g)?.id, id, g);
  // 上诉状卡不接被上诉人答辩与再审；仲裁申请书卡不接劳动仲裁、收到仲裁申请与执行仲裁裁决；庭审提纲不接劳动仲裁
  for (const g of ["被上诉人答辩状怎么写", "申请再审"]) assert.notEqual(suggestScenario(g)?.id, "appeal", g);
  assert.equal(suggestScenario("员工申请劳动仲裁怎么应对")?.id, "labor-response");
  assert.equal(suggestScenario("替员工申请仲裁")?.id, "labor-apply");
  assert.equal(suggestScenario("公司收到仲裁申请书了")?.id, "suit-received");
  assert.equal(suggestScenario("申请执行仲裁裁决")?.id, "enforcement");
  assert.notEqual(suggestScenario("劳动仲裁开庭准备")?.id, "hearing-outline");
  assert.notEqual(suggestScenario("申请证据保全")?.id, "preservation");
  assert.equal(suggestScenario("准备辞退一名员工有什么风险")?.id, "labor-termination", "解除前评估不被规章制度审查抢走");
});
