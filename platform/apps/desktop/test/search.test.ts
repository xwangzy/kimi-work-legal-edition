/**
 * 全局搜索（Z3 评审 §8.2 #31）：每个词都要命中；标题开头命中排前；按事项、任务、交付件分组；空查询不出结果。Ctrl / ⌘ + K 打开（源码对照）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { searchItems, type SearchItem } from "../src/lib/search.ts";

const items: SearchItem[] = [
  { kind: "matter", title: "甲公司股权转让", sub: "乙投资 / 甲科技", href: "/matter/m1", at: "2026-10-20" },
  { kind: "matter", title: "买卖合同纠纷（原告）", sub: "丙公司", href: "/matter/m2", at: "2026-10-21" },
  { kind: "run", title: "审合同", sub: "甲公司股权转让", href: "/run/r1/m1", at: "2026-10-20" },
  { kind: "deliverable", title: "审查意见书（内部稿）", sub: "甲公司股权转让", href: "/review/a1", at: "2026-10-20" },
  { kind: "deliverable", title: "修订稿（原生修订）", sub: "买卖合同纠纷（原告）", href: "/review/a2", at: "2026-10-21" },
];

test("按词命中、分组、标题开头优先", () => {
  const g = searchItems("甲公司", items);
  assert.deepEqual(g.map((x) => [x.kind, x.items.map((i) => i.href)]), [["matter", ["/matter/m1"]], ["run", ["/run/r1/m1"]], ["deliverable", ["/review/a1"]]]);
  assert.deepEqual(searchItems("修订 买卖", items).map((x) => x.items.map((i) => i.href)), [["/review/a2"]], "两个词都要命中（副标题也算）");
  assert.equal(searchItems("合同", items)[0]!.items[0]!.href, "/matter/m2");
  assert.deepEqual(searchItems("   ", items), []);
  assert.deepEqual(searchItems("没有的东西", items), []);
});

test("Ctrl / ⌘ + K 打开搜索；侧栏有搜索入口", () => {
  const app = readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8");
  assert.match(app, /e\.key\.toLowerCase\(\) === "k"/);
  assert.match(app, /<SearchPalette/);
  assert.match(readFileSync(fileURLToPath(new URL("../src/components/Sidebar.tsx", import.meta.url)), "utf8"), /kwl:search/);
});
