/**
 * v9.4 第 22 批界面：事项模板与常用方法、开始面板的审查要点开关与补全提示、材料初判、修订署名与写作偏好、引文页码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { matterFactHints, HINTS_BY_SKILL, RULES_SKILLS } from "../src/lib/matter-hints.ts";
import { triageSuggestion, triageText } from "../src/lib/material-triage.ts";
import { factSourceText } from "../src/lib/facts.ts";
import { SCENARIOS } from "../src/lib/scenarios.ts";
import { STAGE_LABELS } from "../src/lib/matter-stage.ts";
import { MATTER_TEMPLATES } from "../../../packages/kernel/src/services/matter-templates.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);

test("事项模板：推荐的方法都是现有的卡；阶段是阶段条里的取值；常见立场都在新建事项的立场列表里", () => {
  const ids = new Set(SCENARIOS.map((c) => c.id));
  const stances = src("components/NewMatter.tsx");
  for (const t of MATTER_TEMPLATES) {
    for (const id of t.scenarios) assert.ok(ids.has(id), `${t.id} → ${id}`);
    if (t.stage) assert.ok(t.stage in STAGE_LABELS, `${t.id} 阶段 ${t.stage}`);
    for (const s of t.stances) assert.ok(stances.includes(`"${s}"`), `${t.id} 立场 ${s}`);
    assert.ok(t.todos.length >= 2 && t.todos.every((x) => [...x.title].length <= 40), `${t.id} 待办`);
  }
  // 期限只用核过原文的条文
  for (const t of MATTER_TEMPLATES.filter((x) => x.start_fact)) assert.match(t.start_fact!.basis, /《(民事诉讼法|劳动争议调解仲裁法)》第[一二三四五六七八九十百]+条/, t.id);
});

test("审查要点：界面与内核用同一组方法；开始面板可本次不用（review_rules:false 传给内核）", () => {
  const kernel = readFileSync(repo("packages/kernel/src/services/review-rules.ts"), "utf8");
  assert.ok(kernel.includes(`export const RULES_SKILLS: readonly string[] = ${JSON.stringify(RULES_SKILLS).replace(/,/g, ", ")};`), "与内核 RULES_SKILLS 一致");
  assert.match(src("components/ScenarioStart.tsx"), /rules && !useRules \? \{ reviewRules: false \}/);
  assert.match(src("components/RunSheet.tsx"), /p\.reviewRules === false \? \{ review_rules: false \}/);
  // 从范本整理：两张卡都用 review-rules-draft，参数 basis 是方法声明的
  const cards = SCENARIOS.filter((c) => c.skill === "review-rules-draft");
  assert.deepEqual(cards.map((c) => c.line).sort(), ["inhouse", "transactional"]);
  assert.match(readFileSync(repo("content/skills/review-rules-draft/SKILL.md"), "utf8"), /^arguments: \[basis\]$/m);
});

test("补全提示：只按方法列用得到的；填过的不再提示；提示的方法都存在", () => {
  assert.deepEqual(matterFactHints("labor-dispute", { region: null, event_date: null, stage: null }).map((h) => h.field), ["region", "event_date"]);
  assert.deepEqual(matterFactHints("labor-dispute", { region: "上海市", event_date: "2025-06", stage: null }), []);
  assert.deepEqual(matterFactHints("contract-review", { region: null, event_date: null, stage: null }), [], "审合同不催填");
  assert.deepEqual(matterFactHints(null, { region: null, event_date: null, stage: null }), []);
  for (const k of Object.keys(HINTS_BY_SKILL)) assert.ok(existsSync(repo(`content/skills/${k}/SKILL.md`)), k);
  for (const hs of Object.values(HINTS_BY_SKILL)) for (const h of hs) assert.ok([...h.why].length <= 30, h.why);
});

test("材料初判：一句话写类型、合同类型与篇幅；按立场建议方法，认不出不建议", () => {
  const t = (kind: string, extra: Partial<Record<string, unknown>> = {}) => ({ document_version_id: "d", kind, label: "合同", contract_type: null, chars: 12_345, pages: null, size: "medium" as const, ...extra });
  assert.equal(triageText(t("contract", { contract_type: "投资协议（增资 / 股权收购）" })), "合同 · 投资协议 · 约 1.2 万字");
  assert.equal(triageText(t("other", { label: "其他", chars: 830, pages: 3 })), "其他 · 3 页");
  assert.equal(triageText(t("other", { label: "其他", chars: 20 })), "其他 · 约 100 字");
  assert.equal(triageSuggestion(t("contract"), { stance: "买方" })?.id, "contract-review");
  assert.equal(triageSuggestion(t("contract"), { stance: "常年顾问" })?.id, "contract-review-inhouse");
  assert.equal(triageSuggestion(t("complaint"), { stance: "被告" })?.id, "defense");
  assert.equal(triageSuggestion(t("complaint"), { stance: "原告" }), null, "我方的起诉状不建议答辩");
  assert.equal(triageSuggestion(t("judgment_first"), { stance: "原告" })?.id, "appeal");
  assert.equal(triageSuggestion(t("judgment_final"), { stance: "原告" })?.id, "enforcement");
  assert.equal(triageSuggestion(t("judgment_final"), { stance: "被告" }), null, "被执行一方不建议申请执行");
  assert.equal(triageSuggestion(t("judgment_first"), { stance: "买方" }), null, "非诉事项里的判决是参考材料，不建议上诉（走查）");
  assert.equal(triageSuggestion(t("award"), { stance: "常年顾问" }), null);
  assert.equal(triageSuggestion(t("other"), { stance: "原告" }), null);
  const kernel = readFileSync(repo("packages/kernel/src/services/material-triage.ts"), "utf8");
  for (const k of ["contract", "supplement", "complaint", "labor_application", "judgment_first", "judgment_final", "award", "mediation", "policy"]) assert.ok(kernel.includes(`  ${k}: "`), `内核有 ${k}`);
});

test("引文页码：事实出处带页码（按页解析的材料）；Word 不写", () => {
  const files = new Map([["d", "证据.pdf"]]);
  assert.equal(factSourceText({ document_version_id: "d", anchor_status: "located", page: 3 }, files), "证据.pdf 第 3 页");
  assert.equal(factSourceText({ document_version_id: "d", anchor_status: "located" }, files), "证据.pdf");
  assert.match(src("components/TableReview.tsx"), /sel\.cell\.page && <span className="muted">（第 \{sel\.cell\.page\} 页）<\/span>/);
});

test("设置：修订署名随文书版式保存；写作偏好只写格式与文风，提示会发给 AI", () => {
  const ds = src("components/DocStyle.tsx");
  assert.match(ds, /redline_author: draft\.redline_author \?\? ""/);
  assert.match(ds, /placeholder="律师审定（Kimi Work 辅助起草）"/);
  const wp = src("components/WritingPrefs.tsx");
  assert.match(wp, /只写格式与文风，不写案情；会随任务说明一起发给 AI/);
  assert.match(src("pages/Connections.tsx"), /<DocStyle \/>\n\s*<WritingPrefs \/>/);
});
