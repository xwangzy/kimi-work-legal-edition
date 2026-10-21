/**
 * 执行页“数据去向”底部写本次所用的方法模板与版本（Z3 评审 §8.2 #26）；输入框可发送时提示快捷键、不能发送时按钮变灰（#32）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { methodLine } from "../src/lib/run-method.ts";

test("方法与版本：方法模板任务写名称与版本；快照是字符串也能读；不是方法模板任务不写", () => {
  assert.equal(methodLine({ input_snapshot: JSON.stringify({ skill: "contract-review" }) }, { "contract-review": "合同审查（风险卡）" }, { "contract-review": "1.1.1" }), "方法：合同审查（风险卡） · v1.1.1（本所当前分发的版本）");
  assert.equal(methodLine({ input_snapshot: { skill: "x" } }, {}, {}), "方法：x（本所当前分发的版本）");
  assert.equal(methodLine({ input_snapshot: { document_version_ids: [] } }, {}, {}), null);
  assert.equal(methodLine(null, {}, {}), null);
});

test("输入框：可发送时提示快捷键；不能发送时按钮变灰", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/components/Composer.tsx", import.meta.url)), "utf8");
  assert.match(src, /canSend && <span className="send-hint/);
  const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
  assert.match(css, /\.send:disabled \{/);
});
