/**
 * Z3 评审 P1（I2 分支）的界面纯函数与静态门禁：开始面板的默认事项与业务线提醒、缺材料能否先开始、
 * 首页“下一步”胶囊、交付件分组、团队共享一句话、兜底错误文案、核对码分组；律师层文件不出现研发用语、页面不用原生确认框。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canStartPartial, lineMismatchText, matterLine, missingMaterialsText, pickMatterForCard, SCENARIOS } from "../src/lib/scenarios.ts";
import { nextStepPill } from "../src/lib/next-step.ts";
import { groupDeliverables } from "../src/lib/deliverables.ts";
import { syncAlertSummary, teamShareLine } from "../src/lib/relay-text.ts";
import { backendDownText, GENERIC_FAILURE } from "../src/lib/errors.ts";
import { groupDigits } from "../src/lib/labels.ts";

const lit = { matter_id: "m_lit", stance: "原告", created_at: "2026-10-19T08:00:00Z" };
const deal = { matter_id: "m_deal", stance: "受让方", created_at: "2026-10-18T08:00:00Z" };
const deal2 = { matter_id: "m_deal2", stance: "买方", created_at: "2026-10-10T08:00:00Z", activity: { last_at: "2026-10-19T09:00:00Z" } };
const other = { matter_id: "m_other", stance: "其他", created_at: "2026-10-01T08:00:00Z" };
const card = (id: string) => SCENARIOS.find((c) => c.id === id)!;

test("#1 事项业务线：按立场推断；看不出时为 null", () => {
  assert.equal(matterLine(lit), "litigation");
  assert.equal(matterLine({ stance: "plaintiff" }), "litigation");
  assert.equal(matterLine(deal), "transactional");
  assert.equal(matterLine({ stance: "常年顾问" }), "inhouse");
  assert.equal(matterLine(other), null);
  assert.equal(matterLine(null), null);
});

test("#1 开始面板默认事项：非诉卡不默认挂到诉讼事项；优先当前事项，其次最近用过的；没有一致的退到看不出业务线的；都没有为 null（新建事项）", () => {
  // 首页当前是诉讼事项，点“审合同”：选非诉事项里最近用过的
  assert.equal(pickMatterForCard(card("contract-review"), [lit, deal, deal2], "m_lit"), "m_deal2");
  // 当前事项业务线一致时照用当前事项
  assert.equal(pickMatterForCard(card("contract-review"), [lit, deal, deal2], "m_deal"), "m_deal");
  assert.equal(pickMatterForCard(card("casefile"), [lit, deal], "m_deal"), "m_lit");
  // 只有诉讼事项：非诉卡退到看不出业务线的事项；连这种也没有就新建
  assert.equal(pickMatterForCard(card("contract-review"), [lit, other], "m_lit"), "m_other");
  assert.equal(pickMatterForCard(card("contract-review"), [lit], "m_lit"), null);
  assert.equal(pickMatterForCard(card("compliance-qa"), [], null), null);
});

test("#1 业务线不一致只提醒、不阻断：诉讼事项上做审合同给一行字；一致或看不出时不提醒", () => {
  assert.equal(lineMismatchText(card("contract-review"), lit), "这是诉讼仲裁事项。确定在这里做「审合同」吗？");
  assert.equal(lineMismatchText(card("contract-review"), deal), null);
  assert.equal(lineMismatchText(card("contract-review"), other), null);
});

test("#4 缺材料能否先开始：13 张卡里只有起草起诉状、律师函、访谈纪要可以；审合同没有合同只提示“请先添加合同”", () => {
  // 第 15 批 B-5 新增“争点与证据分析”（整理案卷的第二段）；v9.3 诉讼线文书新增答辩状、质证意见、代理词（都要材料或不需要材料，不走“先开始”）；Z3 #28 新增案情分析与诉讼策略（要材料）
  assert.equal(SCENARIOS.length, 20);
  const partial = SCENARIOS.filter((c) => canStartPartial(c)).map((c) => c.id).sort();
  assert.deepEqual(partial, ["demand-lit", "intake", "pleading"]);
  // 真正会出现“先开始”的（需要材料且允许先开始）只有访谈纪要；审合同两张卡都不允许
  assert.deepEqual(SCENARIOS.filter((c) => canStartPartial(c) && c.minMaterials > 0).map((c) => c.id), ["intake"]);
  assert.equal(canStartPartial(card("contract-review")), false);
  assert.equal(canStartPartial(card("contract-review-inhouse")), false);
  // 确定性流程即使声明也不能先开始
  assert.equal(canStartPartial({ allowPartial: true, scenario: "s2.case_file" }), false);
  assert.equal(missingMaterialsText(card("contract-review"), 1), "请先添加合同");
  assert.equal(missingMaterialsText(card("redraft"), 2), "请依次勾选基线稿与对方回稿");
  assert.equal(missingMaterialsText(card("case-report"), 1), "还需要选择 1 份材料");
});

test("#3 继续工作的胶囊写下一步：意见待处理（橙）> 待你复核（蓝）> 可以下载（绿）；出错写需要重试（红）；其余照状态", () => {
  assert.deepEqual(nextStepPill({ status: "succeeded", openOpinions: 4, pendingReview: 1, artifacts: 2 }), { text: "4 项意见待处理", tone: "pill-orange" });
  assert.deepEqual(nextStepPill({ status: "succeeded", openOpinions: 0, pendingReview: 1, artifacts: 2 }), { text: "待你复核", tone: "pill-blue" });
  assert.deepEqual(nextStepPill({ status: "succeeded", openOpinions: 0, pendingReview: 0, artifacts: 2 }), { text: "可以下载", tone: "pill-green" });
  assert.deepEqual(nextStepPill({ status: "succeeded" }), { text: "已完成", tone: "pill-green" });
  // 复核 B13-U09：未签发的草稿不标绿色“可以下载”
  assert.deepEqual(nextStepPill({ status: "succeeded", openOpinions: 0, pendingReview: 0, artifacts: 2, drafts: 1, approved: 1 }), { text: "草稿待提交复核", tone: "pill-blue" });
  assert.deepEqual(nextStepPill({ status: "succeeded", openOpinions: 0, pendingReview: 0, artifacts: 2, drafts: 0, approved: 2 }), { text: "可以下载", tone: "pill-green" });
  assert.equal(nextStepPill({ status: "succeeded", artifacts: 1, drafts: 0, approved: 0 }).text, "已完成", "没有已签发的就不说可以下载");
  assert.deepEqual(nextStepPill({ status: "failed" }), { text: "需要重试", tone: "pill-red" });
  assert.deepEqual(nextStepPill({ status: "timed_out" }), { text: "需要重试", tone: "pill-red" });
  assert.deepEqual(nextStepPill({ status: "waiting_approval", openOpinions: 3 }), { text: "等待你确认", tone: "pill-orange" });
  assert.deepEqual(nextStepPill({ status: "running" }), { text: "执行中", tone: "pill-blue" });
});

test("#2 交付件按事项分组：保持新的在前，每个事项一组", () => {
  const rows = [
    { id: 1, matter_id: "a", matter_title: "甲" },
    { id: 2, matter_id: "b", matter_title: "乙" },
    { id: 3, matter_id: "a", matter_title: "甲" },
  ];
  const g = groupDeliverables(rows);
  assert.deepEqual(g.map((x) => [x.matter_id, x.rows.map((r) => r.id)]), [["a", [1, 3]], ["b", [2]]]);
  assert.deepEqual(groupDeliverables([]), []);
});

test("#7 团队共享律师层只有一句话：不讲密钥、起点、控制成员", () => {
  const s = syncAlertSummary({ title: "甲案", peer_name: "林律师" });
  assert.equal(s, "「甲案」暂时不能同步给同事，负责人 林律师 处理后会自动恢复。");
  assert.equal(syncAlertSummary({ title: null }), "有一个事项暂时不能同步给同事，负责人处理后会自动恢复。");
  assert.equal(teamShareLine({ blocked: null, alerts: [] }), "同事之间同步：正常");
  assert.equal(teamShareLine({ blocked: null, alerts: [{}, {}] }), "有 2 个事项暂停同步，负责人处理后自动恢复");
  assert.match(teamShareLine({ blocked: "not_allowed", policy_fallback: true }), /律所规则/);
  for (const t of [s, teamShareLine({ blocked: "exit_mode" }), teamShareLine({ blocked: "not_allowed" })]) assert.doesNotMatch(t, /密钥|起点|控制成员|中继|策略|吊销/);
});

test("#13 兜底错误文案：律师层不出现内核、开发桥、端口；开发环境另附提示", () => {
  assert.doesNotMatch(backendDownText(false), /内核|开发桥|127\.0\.0\.1|7720/);
  assert.match(backendDownText(false), /导出诊断信息/);
  assert.match(backendDownText(true), /开发桥/);
  assert.equal(GENERIC_FAILURE, "操作没有完成，请重试。");
});

test("核对码每 4 位一组", () => {
  assert.equal(groupDigits("602238728312"), "6022 3872 8312");
  assert.equal(groupDigits("60223 87283 1"), "6022 3872 831");
  assert.equal(groupDigits(""), "");
});

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
/** 只看用户可见的文字：去掉注释后取字符串字面量、模板字符串与 JSX 文本。 */
function visibleTexts(file: string): string[] {
  const src = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return [
    ...src.matchAll(/"(?:[^"\\\n]|\\.)*"/g),
    ...src.matchAll(/`(?:[^`\\]|\\.)*`/g),
    ...src.matchAll(/>([^<>{}]*[一-鿿][^<>{}]*)</g),
  ].map((m) => m[0]);
}

test("#8 律师层文件不出现研发用语（执行域、跨边界、出站闸门、Playbook、确定性工作流、检索上游、事项账本、计点）", () => {
  const files = [
    "components/Composer.tsx",
    "components/ModeSelector.tsx",
    "components/ScenarioStart.tsx",
    "components/Cards.tsx",
    "components/TeamShare.tsx",
    "components/MatterHeader.tsx",
    "components/RunSheet.tsx",
    "lib/labels.ts",
    "lib/badges.ts",
    "lib/relay-text.ts",
    "pages/Home.tsx",
    "pages/Deliverables.tsx",
    "pages/Review.tsx",
    // 第 14 批第二轮复核 R2B-20：恢复与备份、激活页
    "components/RecoveryBackup.tsx",
    "pages/Activate.tsx",
  ].map((f) => join(SRC, f));
  files.push(fileURLToPath(new URL("../../../packages/kernel/src/services/interaction-cards.ts", import.meta.url)));
  const BANNED = /执行域|跨边界|出站闸门|Playbook|确定性工作流|检索上游|事项账本|计点/;
  const hits: string[] = [];
  for (const f of files) for (const t of visibleTexts(f)) if (/[一-鿿]/.test(t) && BANNED.test(t)) hits.push(`${f.slice(SRC.length)}：${t.slice(0, 60)}`);
  assert.deepEqual(hits, []);
});

test("#13 页面与组件不用浏览器原生确认框（改用 ConfirmButton）", () => {
  const files: string[] = [];
  for (const d of ["components", "pages"]) for (const n of readdirSync(join(SRC, d))) if (statSync(join(SRC, d, n)).isFile()) files.push(join(SRC, d, n));
  const hits = files.filter((f) => /window\.confirm\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, []);
});

test("复核 B13-U06：模式说明不写“AI 都不能自己联网”（与预授权检索、官方网站不用问相矛盾）", () => {
  const src = readFileSync(join(SRC, "components/ModeSelector.tsx"), "utf8");
  assert.doesNotMatch(src, /不能自己联网/);
  assert.match(src, /联网都要经过本应用的检查/);
});
