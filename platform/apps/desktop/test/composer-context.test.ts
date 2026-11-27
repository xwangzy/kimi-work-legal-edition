/**
 * Z3 #12（M-4）输入框顶部事项上下文行：事项名不在底栏右下角被截断；超过 28 字才截断，悬停看全称。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clipTitle } from "../src/lib/labels.ts";

test("#12 事项名 28 字以内完整显示，超过才截断", () => {
  const t = "丙公司诉丁公司买卖合同纠纷（原告代理）";
  assert.equal(clipTitle(t), t, "评审截图里被截成“（原告”的名称现在完整显示");
  const long = "甲".repeat(30);
  assert.equal(clipTitle(long), `${"甲".repeat(28)}…`);
});

test("#12 输入框：事项放在输入框下方托盘（2026-11 对齐 Kimi“选择项目”同位），底栏不再有事项胶囊；事项页内写“本事项”并带我方立场", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "components", "Composer.tsx"), "utf8");
  assert.match(src, /className="composer-context"/);
  assert.match(src, /事项：\{props\.matterId \? "本事项"/);
  assert.match(src, /我方：/);
  // 托盘在输入框（文本框与底栏）之后：发起前仍一眼看得到在哪个事项下工作
  assert.ok(src.indexOf('className="composer-context"') > src.indexOf("<ComposerFrame"), "事项托盘在输入框下方");
  // 第 72 批：底栏由共用外壳 ComposerFrame 画，左槽 / 右槽在 <ComposerFrame ...> 的属性里
  const bar = src.slice(src.indexOf("<ComposerFrame"), src.indexOf('className="composer-context"'));
  assert.doesNotMatch(bar, /Icon\.folder/, "底栏只留导入、模式和发送");
  assert.match(bar, /tool-plus/, "左下“+”导入材料");
  const tray = src.slice(src.indexOf('className="composer-context"'), src.indexOf("{menu === \"method\" && ("));
  assert.match(tray, /方法/);
  assert.match(tray, /材料/);
});
