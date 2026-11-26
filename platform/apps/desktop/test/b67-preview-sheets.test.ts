/**
 * V41 第 67 批工作线 E：Excel 预览分表显示（表签在隔离框架外，框架里一次一张表）与纸面版式。
 * 隔离框架是 sandbox=""（不执行脚本），表签只能由界面渲染；拆分只按内核输出的结构切，每一份仍整份经 buildPreviewDoc 清洗。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitSheets } from "../src/lib/safe-preview.ts";

const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");

test("新版内核输出：按 section.kwl-sheet 拆成一张张表，表名解开转义，样式块与表后的说明每张表都带上", () => {
  const html = `<style>.kwl-grid td.x1{font-weight:700}</style><section class="kwl-sheet" data-sheet-name="证据目录"><table class="kwl-grid"><tbody><tr><td>借款合同</td></tr></tbody></table></section>
<section class="kwl-sheet" data-sheet-name="甲&quot;&lt;乙&gt;&amp;丙"><table class="kwl-grid"><tbody><tr><td>计算</td></tr></tbody></table></section><p class="kwl-note">另有 1 张隐藏的工作表未显示</p>`;
  const r = splitSheets(html)!;
  assert.deepEqual(r.sheets.map((s) => s.name), ["证据目录", '甲"<乙>&丙']);
  assert.match(r.head, /^<style>\.kwl-grid td\.x1/);
  assert.match(r.sheets[0]!.html, /借款合同/);
  assert.doesNotMatch(r.sheets[0]!.html, /计算/);
  assert.match(r.tail, /另有 1 张隐藏的工作表未显示/);
  assert.doesNotMatch(r.tail, /<style/);
});

test("旧版内核输出（section > h3 表名 + 平铺表格）同样拆得开：开发桥没重启、旧安装包的内核也能分表显示", () => {
  const html = `<style>table{border-collapse:collapse}</style><section><h3>问题清单</h3><table><tr><th>条款</th></tr></table></section>\n<section><h3>附表</h3><table><tr><td>x</td></tr></table></section><p><em>（预览只显示每个表前 500 行，请下载查看全部）</em></p>`;
  const r = splitSheets(html)!;
  assert.deepEqual(r.sheets.map((s) => s.name), ["问题清单", "附表"]);
  assert.doesNotMatch(r.sheets[0]!.html, /<h3>/, "表名改由表签显示，不再在框架里重复");
  assert.match(r.tail, /前 500 行/);
});

test("不是表格预览（Word）不拆", () => {
  assert.equal(splitSheets(`<style>p{}</style><p>民事起诉状</p>`), null);
});

test("SafePreview：表签在框架外（role=tablist），框架仍只有一个、仍是 sandbox=\"\"、按内容摘要换新元素；说明条按 Word / Excel 分开说", () => {
  const sp = src("components/SafePreview.tsx");
  assert.equal((sp.match(/<iframe\b/g) ?? []).length, 1);
  assert.match(sp, /sandbox=""/);
  assert.match(sp, /key=\{`\$\{frameKey\}:\$\{reloads\}`\}/);
  assert.ok(sp.indexOf('role="tablist"') > 0 && sp.indexOf('role="tablist"') < sp.indexOf("<iframe"), "表签在框架外、框架之前");
  assert.match(sp, /isSheet \? "Excel" : "Word"/);
  assert.match(sp, /以 \{app\} 打开为准/);
  // Excel 不套文书纸面，Word 才用纸面
  assert.match(sp, /paper: !!office && !isSheet, sheet: isSheet/);
  const lib = src("lib/safe-preview.ts");
  assert.match(lib, /o\.paper && !o\.sheet \? `<div class="kwl-paper">\$\{inner\}<\/div>`/);
  assert.match(lib, /o\.sheet \? `<style>\$\{SHEET_STYLE\}<\/style>` : o\.paper \? `<style>\$\{PAPER_STYLE\}<\/style>`/);
});
