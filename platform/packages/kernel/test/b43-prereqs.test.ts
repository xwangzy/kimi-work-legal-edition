/** V18 第 43 批：缺构建产物时内核用例直接失败并说明怎么补，不再挂起。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingPrereqs } from "./helpers.ts";

test("构建产物齐全时没有缺项", () => {
  assert.deepEqual(missingPrereqs(), []);
});

test("缺哪一项就点名哪一项，并给出补的命令", () => {
  const miss = missingPrereqs((p) => !p.includes("skills.manifest.json") && !p.includes("lawdb.sqlite"));
  assert.equal(miss.length, 2);
  assert.ok(miss.some((m) => m.includes("content/lawdb/dist/lawdb.sqlite") && m.includes("npm run build:lawdb")));
  assert.ok(miss.some((m) => m.includes("content/skills/dist/skills.manifest.json") && m.includes("npm run build:skills")));
});
