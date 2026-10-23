/**
 * v9.4 第 25 批界面：审查工作台修改框挡住的范本占位符，与内核放入范本时换上、签修改时再挡的是同一组（复核 Q6-12）。
 * 内核加了占位符时界面跟着改，否则界面放行、内核拒收，律师只看到一条报错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("工作台修改框的占位符清单与内核 HIT_LABEL 一致", () => {
  const kernel = read("../../../packages/kernel/src/services/firm-templates.ts");
  const labels = [...(/const HIT_LABEL[^=]*=\s*\{([^}]*)\}/.exec(kernel)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(labels.length >= 9, "读到内核的占位符清单");
  const ui = /const PLACEHOLDER = \/【\(([^)]*)\)】\//.exec(read("../src/components/ReviewWorkbench.tsx"))?.[1]?.split("|") ?? [];
  assert.deepEqual([...ui].sort(), [...labels].sort());
});
