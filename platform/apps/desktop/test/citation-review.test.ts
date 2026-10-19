/** 复核页引用核对的分组与签发判定（第 13 批复核 B13-U01/U02/U03）：与内核签发门禁同一判定、同名勾选键。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { citationChecklist, citationNeeds, citationsAllowSign } from "../src/lib/citation-review.ts";

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
  assert.deepEqual(citationNeeds(null), { wrong: [], cases: [], outside: [], unchecked: false });
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
