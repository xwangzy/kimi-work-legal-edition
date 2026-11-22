/**
 * 第 56 批（偏离 D-223）：任务页的“复核建议”与时间线文案。
 * - 只有建议时列出全部建议；必须改回看未落实的只列没落实的；修改轮没做完的列全部；
 * - 勾选后拼成以“按独立复核意见修改”开头的追问，代号按界面还原；
 * - 修改轮没做完的时间线：已改出新版本的不写“文书是复核前的版本”，旧事件不下结论（与内核“还差什么”一致）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pendingReviewSuggestions, REVIEW_APPLY_HEAD, reviewApplyText } from "../src/lib/review-suggestions.ts";
import { buildSteps } from "../src/lib/timeline.ts";

let id = 0;
const ev = (type: string, payload: Record<string, unknown> = {}) => ({ event_id: ++id, seq: id, type, payload, created_at: "2026-11-22T10:00:00Z" }) as any;
const items = [
  { no: 1, level: "should", where: "第一条", problem: "标的型号未写", fix: "补写型号" },
  { no: 2, level: "must", where: "第二条", problem: "价款与〔自然人·ABCDEF〕确认的不一致", fix: "改为 120 万元" },
  { no: 3, level: "risk", where: "", problem: "未约定质保期", fix: "" },
];

test("只有建议：列出全部建议；必须改回看未落实：只列没落实的；修改轮没做完：列全部；处理完的不列", () => {
  const sug = pendingReviewSuggestions([ev("review.completed", { findings: 3, must: 0, items }), ev("review.skipped", { reason: "suggestions_only" })]);
  assert.equal(sug?.mode, "suggestions");
  assert.equal(sug?.items.length, 3);
  const open = pendingReviewSuggestions([ev("review.completed", { findings: 3, must: 1, items }), ev("review.fix_started"), ev("review.fix_outcome", { status: "succeeded" }), ev("review.followup", { open: [2], unknown: [] })]);
  assert.deepEqual([open?.mode, open?.items.map((x) => x.no)], ["open", [2]]);
  const half = pendingReviewSuggestions([ev("review.completed", { findings: 3, must: 1, items }), ev("review.fix_started"), ev("review.fix_outcome", { status: "timed_out", revised: 1 })]);
  assert.equal(half?.mode, "unfinished");
  assert.equal(pendingReviewSuggestions([ev("review.completed", { findings: 3, must: 1, items }), ev("review.fix_outcome", { status: "succeeded" }), ev("review.followup", { open: [], unknown: [] })]), null);
  // 旧事件没有逐条载荷：不显示
  assert.equal(pendingReviewSuggestions([ev("review.completed", { findings: 3, must: 0 }), ev("review.skipped", { reason: "suggestions_only" })]), null);
});

test("勾选的意见拼成追问：以固定开头起句、写级别、代号按界面还原、附处理要求", () => {
  const text = reviewApplyText(items.slice(0, 2) as any, (t) => t.replace("〔自然人·ABCDEF〕", "张三"));
  assert.ok(text.startsWith(REVIEW_APPLY_HEAD));
  assert.match(text, /勾选要采纳的 2 条/);
  assert.match(text, /【1】（建议改）位置：第一条；问题：标的型号未写；改法：补写型号/);
  assert.match(text, /【2】（必须改）[^\n]*张三确认的不一致/);
  assert.match(text, /不成立的不改并写明理由/);
});

test("时间线：只有建议时写“没有自动修改”；修改轮没做完按是否改出新版本区分，旧事件不下结论", () => {
  const sug = buildSteps([ev("review.completed", { findings: 2, must: 0 }), ev("review.skipped", { reason: "suggestions_only" })]);
  assert.equal(sug[0]!.title, "独立复核提出 2 条建议，没有必须改的");
  assert.equal(sug[1]!.title, "复核建议没有自动修改，由你决定是否采纳");
  assert.equal(sug[1]!.icon, "ok", "不进“没做完的地方”");
  assert.match(buildSteps([ev("review.completed", { findings: 2, must: 1 })])[0]!.title, /其中必须改 1 条），已交回助手处理/);
  assert.equal(buildSteps([ev("review.skipped", { reason: "review_apply" })])[0]!.icon, "ok");
  const revised = buildSteps([ev("review.fix_outcome", { status: "timed_out", revised: 2, revised_files: ["意见书.docx"] })])[0]!;
  assert.equal(revised.title, "按复核意见修改超过时限，已改出新版本但没有全部改完");
  assert.match(revised.detail ?? "", /《意见书》/);
  assert.doesNotMatch(revised.title, /复核前的版本/);
  assert.match(buildSteps([ev("review.fix_outcome", { status: "failed", revised: 0 })])[0]!.title, /文书是复核前的版本/);
  assert.match(buildSteps([ev("review.fix_outcome", { status: "start_failed" })])[0]!.title, /文书是复核前的版本/);
  const old = buildSteps([ev("review.fix_outcome", { status: "timed_out" })])[0]!;
  assert.equal(old.title, "按复核意见修改超过时限");
  assert.doesNotMatch(`${old.title}${old.detail}`, /复核前的版本/);
});

test("任务页：复核建议区块在结果之后、勾选后复用追问并带 review_apply；样式放在 styles-run.css", () => {
  const src = readFileSync(new URL("../src/pages/RunView.tsx", import.meta.url), "utf8");
  assert.match(src, /\{reviewEl\}/);
  assert.match(src, /按勾选的意见修改/);
  assert.match(src, /review_apply: true/);
  assert.match(src, /void prepareFollowUp\(text\)/);
  const css = readFileSync(new URL("../src/styles-run.css", import.meta.url), "utf8");
  assert.match(css, /\.review-sugg \{/);
});
