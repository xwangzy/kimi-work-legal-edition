/** 复核 R15B-01：事项页“事实”——计数、出处一句话；界面确实调用了确认接口（不再只有定义）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { factCounts, factSourceText } from "../src/lib/facts.ts";

test("事实计数与出处", () => {
  assert.deepEqual(factCounts([{ status: "proposed" }, { status: "confirmed" }, { status: "proposed" }]), { proposed: 2, confirmed: 1, rejected: 0 });
  const files = new Map([["d1", "买卖合同.docx"]]);
  assert.equal(factSourceText({ document_version_id: "d1", anchor_status: "located" }, files), "买卖合同.docx");
  assert.match(factSourceText({ document_version_id: "d1", anchor_status: "not_found" }, files), /没有找到原文/);
  assert.equal(factSourceText({ document_version_id: null, anchor_status: "no_document" }, files), "没有关联材料");
});

test("事项页有“事实”标签，并调用确认接口", () => {
  const src = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8");
  assert.match(src("components/FactsPanel.tsx"), /api\.decideFact\(/);
  assert.match(src("pages/Matter.tsx"), /\["facts", "事实"\]/);
  assert.match(src("pages/Matter.tsx"), /<FactsPanel /);
});
