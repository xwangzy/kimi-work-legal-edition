/**
 * V12 R-6：手打“第 N 条”的合同在新增或删除一条后，条号不会像自动编号那样顺延（新增“第六条”后原第六条仍写第六条）。
 * 工具结果原先只比较自动编号，照样告诉助手“后续编号已自动顺延，不要写后续编号保持不动”。现在列出改后新出现的重复与跳号。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocx } from "@zr-legal/docx-engine";
import { articleNumber, numberingShifts } from "../src/services/structured-patch.ts";

test("条号数字：中文与阿拉伯数字", () => {
  assert.equal(articleNumber("第六条 保险"), 6);
  assert.equal(articleNumber("第十条"), 10);
  assert.equal(articleNumber("第十二条 其他"), 12);
  assert.equal(articleNumber("第二十条"), 20);
  assert.equal(articleNumber("第一百零五条"), 105);
  assert.equal(articleNumber("第 7 条"), 7);
  assert.equal(articleNumber("依第六条约定"), null);
});

test("改后新出现的重复、跳号才列出；原稿本来跳号的不算", () => {
  const doc = (titles: string[]) => createDocx("合同", titles.map((t) => ({ heading: "", paragraphs: [t, "正文。"] })));
  const before = doc(["第五条 维修", "第六条 保险", "第七条 违约"]);
  const dup = numberingShifts(before, doc(["第五条 维修", "第六条 数据", "第六条 保险", "第七条 违约"]));
  assert.deepEqual(dup.articles, { duplicates: ["第六条"], gaps: [] });
  const gap = numberingShifts(before, doc(["第五条 维修", "第七条 违约"]));
  assert.deepEqual(gap.articles, { duplicates: [], gaps: ["第五条之后是第七条"] });
  assert.equal(numberingShifts(before, doc(["第五条 维修", "第六条 保险", "第七条 违约"])).articles, undefined);
  const skipped = doc(["第一条", "第三条"]);
  assert.equal(numberingShifts(skipped, skipped).articles, undefined, "原稿就跳号的不报");
});
