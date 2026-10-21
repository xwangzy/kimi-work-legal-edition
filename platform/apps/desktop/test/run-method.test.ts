/**
 * 执行页“数据去向”底部写本次所用的方法模板与版本（Z3 评审 §8.2 #26）；输入框可发送时提示快捷键、不能发送时按钮变灰（#32）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { methodLine } from "../src/lib/run-method.ts";

test("方法与版本：方法模板任务写名称与版本；快照是字符串也能读；不是方法模板任务不写", () => {
  // 任务开始时写进快照的版本优先（余项续复核 RC-B-14）：模板升级后老任务仍显示当时那一版
  assert.equal(methodLine({ input_snapshot: JSON.stringify({ skill: "contract-review", skill_title: "合同审查（风险卡）", skill_version: "1.1.0" }) }, { "contract-review": "合同审查（风险卡）" }, { "contract-review": "1.2.0" }), "方法：合同审查（风险卡） · v1.1.0（任务开始时的版本）");
  assert.equal(methodLine({ input_snapshot: JSON.stringify({ skill: "contract-review" }) }, { "contract-review": "合同审查（风险卡）" }, { "contract-review": "1.1.1" }), "方法：合同审查（风险卡） · 版本未记录（本所当前使用的是 v1.1.1）");
  assert.equal(methodLine({ input_snapshot: { skill: "x-removed" } }, {}, {}), "方法：已下架的方法模板 · 版本未记录", "模板不在本机：不显示内部编号");
  assert.equal(methodLine({ input_snapshot: { document_version_ids: [] } }, {}, {}), null);
  assert.equal(methodLine(null, {}, {}), null);
});

test("输入框：可发送时提示快捷键；不能发送时按钮变灰并写原因；问答页写明回车发送（余项续复核 RC-B-15）", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/components/Composer.tsx", import.meta.url)), "utf8");
  assert.match(src, /canSend \? `\$\{SEND_KEY\} 发送` : blockedReason/);
  assert.match(src, /"先选事项" : "先写任务目标"/);
  assert.match(readFileSync(fileURLToPath(new URL("../src/pages/Chat.tsx", import.meta.url)), "utf8"), /回车发送 · Shift \+ 回车换行/);
  const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
  assert.match(css, /\.send:disabled \{/);
});
