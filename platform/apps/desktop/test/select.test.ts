/**
 * Z3 #15 统一下拉框与材料用途胶囊：键盘导航纯函数 + “律师层没有原生 select”门禁。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { displayLabel, initialActive, moveActive, typeahead, type SelectOption } from "../src/lib/select-nav.ts";

const opts: SelectOption[] = [
  { value: "a", label: "我方" },
  { value: "b", label: "对方", disabled: true },
  { value: "c", label: "参考" },
  { value: "d", label: "Docx" },
];

test("#15 键盘导航：跳过不可选项、到头不回绕、Home/End", () => {
  assert.equal(moveActive(opts, 0, "ArrowDown"), 2, "跳过不可选的“对方”");
  assert.equal(moveActive(opts, 3, "ArrowDown"), 3, "到底停住");
  assert.equal(moveActive(opts, 2, "ArrowUp"), 0);
  assert.equal(moveActive(opts, 0, "ArrowUp"), 0, "到顶停住");
  assert.equal(moveActive(opts, -1, "ArrowDown"), 0);
  assert.equal(moveActive(opts, 2, "Home"), 0);
  assert.equal(moveActive(opts, 0, "End"), 3);
  assert.equal(moveActive([{ value: "x", label: "x", disabled: true }], -1, "ArrowDown"), -1, "全不可选");
});

test("#15 打开时停在当前值；当前值不可选或为空时停在第一项", () => {
  assert.equal(initialActive(opts, "c"), 2);
  assert.equal(initialActive(opts, "b"), 0);
  assert.equal(initialActive(opts, ""), 0);
});

test("#15 键入首字跳转与显示文字", () => {
  assert.equal(typeahead(opts, 0, "d"), 3);
  assert.equal(typeahead(opts, -1, "D"), 3);
  assert.equal(typeahead(opts, 0, "z"), 0, "没有匹配不动");
  assert.equal(displayLabel(opts, "c"), "参考");
  assert.equal(displayLabel(opts, "", "选择事项"), "选择事项");
});

test("#15 门禁：页面与组件不出现原生 <select>（统一用 components/Select.tsx）", () => {
  const root = join(import.meta.dirname, "..", "src");
  const hits: string[] = [];
  for (const dir of ["pages", "components"]) {
    for (const f of readdirSync(join(root, dir))) {
      if (!/\.tsx?$/.test(f)) continue;
      readFileSync(join(root, dir, f), "utf8").split("\n").forEach((line, i) => {
        if (/<select[\s>]|<option[\s>]/.test(line)) hits.push(`${dir}/${f}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(hits, []);
});

test("#15 材料用途：材料表与开始面板都用三枚胶囊，不再有“未标”下拉", () => {
  const src = (p: string) => readFileSync(join(import.meta.dirname, "..", "src", p), "utf8");
  assert.match(src("pages/Matter.tsx"), /<RolePills/);
  assert.match(src("components/ScenarioStart.tsx"), /<RolePills/);
  assert.doesNotMatch(src("pages/Matter.tsx"), />未标</);
});
