/** 复核页引用核对的分组与签发判定（第 13 批复核 B13-U01/U02/U03）：与内核签发门禁同一判定、同名勾选键。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { citationChecklist, citationNeeds, citationsAllowSign, partialPagesText } from "../src/lib/citation-review.ts";

const ac = (items: { raw: string; kind: "wrong" | "case" | "outside" | "ok" }[], checked = true) => ({
  checked,
  wrong: items.filter((i) => i.kind === "wrong").length,
  unverified_offline: items.filter((i) => i.kind === "case").length,
  outside_registry: items.filter((i) => i.kind === "outside").length,
  items: items.map((i) => ({ ...i, reason: null })),
});
const none = { cases: false, outside: false, unchecked: false };

test("分组：核对不通过、案号、法规库外分开列；系统没核对另成一类；没有核验结果时什么都不要求", () => {
  const n = citationNeeds(ac([{ raw: "A", kind: "wrong" }, { raw: "B", kind: "case" }, { raw: "C", kind: "outside" }, { raw: "D", kind: "ok" }]));
  assert.deepEqual([n.wrong.map((x) => x.raw), n.cases.map((x) => x.raw), n.outside.map((x) => x.raw), n.unchecked], [["A"], ["B"], ["C"], false]);
  assert.equal(citationNeeds(ac([], false)).unchecked, true);
  assert.deepEqual(citationNeeds(null), { wrong: [], cases: [], outside: [], timing: [], counts: { wrong: 0, cases: 0, outside: 0, timing: 0, supportPending: 0, unsupported: 0 }, eventDate: null, unchecked: false, partial: 0, unrecognized: 0 });
});

test("复核 A-13：条目列表截断（法规库外的都在第 200 条之后）时按内核计数仍要求勾选，不让律师无路可走", () => {
  const truncated = { checked: true, wrong: 0, unverified_offline: 0, outside_registry: 250, items: Array.from({ length: 200 }, (_, i) => ({ raw: `ok${i}`, kind: "ok" as const, reason: null })) };
  const n = citationNeeds(truncated);
  assert.equal(n.outside.length, 0);
  assert.equal(n.counts.outside, 250);
  assert.equal(citationsAllowSign(n, none), false);
  assert.deepEqual(citationChecklist(n, { ...none, outside: true }), { citations_outside_registry_checked: true });
  assert.equal(citationsAllowSign(n, { ...none, outside: true }), true);
});

test("签发判定：有核对不通过的不能签；案号、法规库外、系统没核对须各自勾选；勾选键与内核同名", () => {
  assert.equal(citationsAllowSign(citationNeeds(ac([{ raw: "A", kind: "wrong" }])), { cases: true, outside: true, unchecked: true }), false);
  const n = citationNeeds(ac([{ raw: "B", kind: "case" }, { raw: "C", kind: "outside" }]));
  assert.equal(citationsAllowSign(n, none), false);
  assert.equal(citationsAllowSign(n, { cases: true, outside: false, unchecked: false }), false);
  assert.equal(citationsAllowSign(n, { cases: true, outside: true, unchecked: false }), true);
  assert.deepEqual(citationChecklist(n, { cases: true, outside: true, unchecked: false }), { citations_cases_checked: true, citations_outside_registry_checked: true });
  const u = citationNeeds(ac([], false));
  assert.equal(citationsAllowSign(u, none), false);
  assert.deepEqual(citationChecklist(u, { ...none, unchecked: true }), { citations_unverifiable_checked: true });
  assert.equal(citationsAllowSign(citationNeeds(ac([{ raw: "D", kind: "ok" }])), none), true);
});

test("复核 R2B-27：运行里在材料中核到的离线案号与成果里的案号同一个勾选；没有成果级核验结果时也要求勾选", () => {
  const n = citationNeeds(ac([{ raw: "D", kind: "ok" }]), 2);
  assert.equal(n.counts.cases, 2);
  assert.equal(citationsAllowSign(n, none), false);
  assert.deepEqual(citationChecklist(n, { ...none, cases: true }), { citations_cases_checked: true });
  assert.equal(citationsAllowSign(n, { ...none, cases: true }), true);
  assert.equal(citationNeeds(null, 1).counts.cases, 1);
  assert.equal(citationsAllowSign(citationNeeds(null, 1), none), false);
});

test("签发页（Astra M-2）：没通过的系统检查项可直接去处理；有材料缺口须勾选“已向客户说明”才能签发；显示复核人或签发人", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/pages/Review.tsx", import.meta.url)), "utf8");
  assert.match(src, /去看材料/);
  assert.match(src, /去核对/);
  assert.match(src, /看最新版本/);
  assert.match(src, /gaps_disclosed: gapsAck/);
  assert.match(src, /\(gaps > 0 && !gapsAck\)/, "缺口没确认时签发按钮不可用");
  assert.match(src, /复核人：/);
  assert.match(src, /签发人：/);
  assert.match(src, /退回人：/, "已退回的显示退回人（复核 RB16B-09）");
  assert.match(src, /我已知悉，结论没有覆盖这些材料/, "内部稿不要求声明“已向客户说明”（复核 RB16B-08）");
  assert.match(src, /本所其他成员/);
  assert.match(src, /latest_artifact_version_id/, "看最新版本直达最新版（复核 RB16B-07）");
});

test("页级读不清（v9.3 主文 §9 第 9 项默认做法）：只列出份数、页数与页码区间，不要求勾选", () => {
  assert.equal(partialPagesText([{ filename: "合同.pdf", pages: [3, 4, 5, 9], total: 4 }]), "1 份共 4 页（合同.pdf 第 3–5、9 页）");
  assert.equal(partialPagesText([{ filename: "a.pdf", pages: [1], total: 40 }]), "1 份共 40 页（a.pdf 第 1 页 等）");
  const src = readFileSync(fileURLToPath(new URL("../src/pages/Review.tsx", import.meta.url)), "utf8");
  assert.match(src, /部分页读不清/);
});

test("几乎没有文字的页单独一句，不算读不清（余项续复核 RC-B-04）", async () => {
  const { blankPagesText } = await import("../src/lib/citation-review.ts");
  assert.equal(partialPagesText([{ filename: "合同.pdf", pages: [], total: 0 }, { filename: "证据.pdf", pages: [2], total: 1 }]), "1 份共 1 页（证据.pdf 第 2 页）");
  assert.equal(blankPagesText([{ blank: 2 }, { blank: 1 }]), "另有 3 页几乎没有文字（多为空白页、印章页或签署页），没有算作读不清");
  assert.equal(blankPagesText([{ blank: 0 }, {}]), "");
});

test("论断—依据（C-03）：颜色取最弱一层、律师确认与系统核验分开；排序先要处理的；汇总只写不为 0 的；支持性没处理完不能签", async () => {
  const { citeTone, sortClaims, claimsSummary, previewCites, markOf } = await import("../src/lib/citation-review.ts");
  const items = [
    { raw: "A", kind: "ok" as const, reason: null, key: "A#1", decision: "supported" as const },
    { raw: "B", kind: "ok" as const, reason: null, key: "B#1" },
    { raw: "C", kind: "outside" as const, reason: "库外", key: "C#1" },
    { raw: "D", kind: "wrong" as const, reason: "条号超出", key: "D#1" },
    { raw: "E", kind: "ok" as const, reason: null, key: "E#1", decision: "acknowledged" as const },
    { raw: "A", kind: "ok" as const, reason: null, key: "A#2", decision: "unsupported" as const },
  ];
  assert.deepEqual(items.map(citeTone), ["confirmed", "orange", "gray", "red", "ack", "red"]);
  assert.deepEqual(sortClaims(items).map((i) => i.key), ["D#1", "A#2", "B#1", "C#1", "E#1", "A#1"]);
  assert.equal(claimsSummary(items), "6 处引用：律师已确认 1 · 律师已知悉 1 · 支持待判 1 · 系统没法核对 1 · 不通过或不支持 2");
  const marks = previewCites(items);
  assert.deepEqual(marks.map((m) => [m.raw, m.nth, m.mark]), [["A", 1, "①"], ["B", 1, "②"], ["C", 1, "③"], ["D", 1, "④"], ["E", 1, "⑤"], ["A", 2, "⑥"]]);
  assert.match(marks[1]!.title, /支持 待判/);
  assert.equal(markOf(21), "[21]");
  const n = citationNeeds({ checked: true, wrong: 0, unverified_offline: 0, outside_registry: 0, support_pending: 1, unsupported: 0, items: [] });
  assert.equal(citationsAllowSign(n, none), false);
  const u = citationNeeds({ checked: true, wrong: 0, unverified_offline: 0, outside_registry: 0, support_pending: 0, unsupported: 1, items: [] });
  assert.equal(citationsAllowSign(u, none), false);
  assert.equal(citationsAllowSign(citationNeeds({ checked: true, wrong: 0, unverified_offline: 0, outside_registry: 0, support_pending: 0, unsupported: 0, items: [] }), none), true);
});

test("预览角标（C-03）：Markdown 与隔离框架都按“第几次出现”加角标；框架里的角标有悬停说明、不带脚本", async () => {
  const src = readFileSync(new URL("../src/components/Markdown.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("cite-mark cite-tone-") && src.includes("x.nth === h.nth") && src.includes("scanMarks("), "按共用扫描（cite-scan.ts）的第几次出现加角标");
  const sp = readFileSync(new URL("../src/lib/safe-preview.ts", import.meta.url), "utf8");
  assert.ok(sp.includes('sup.className = `kwl-cite kwl-cite-${c.tone}`') && sp.includes("sup.title = c.title") && sp.includes("scanMarks("));
  const rv = readFileSync(new URL("../src/pages/RunView.tsx", import.meta.url), "utf8");
  assert.ok(rv.includes("<CitationClaims") && rv.includes("cites: previewMarks"));
  const review = readFileSync(new URL("../src/pages/Review.tsx", import.meta.url), "utf8");
  assert.ok(review.includes("<CitationClaims") && review.includes("{ cites }"));
});
