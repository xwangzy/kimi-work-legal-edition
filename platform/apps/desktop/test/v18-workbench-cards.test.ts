/**
 * V18 包一（A5 审查工作台版式、A6 确认卡统一外壳、A10 材料表列宽）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitPlan } from "../src/lib/plan-sections.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
/** styles.css 里某个选择器的声明（取最后一条同名规则，后写的覆盖前面的）。 */
const rule = (css: string, sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const all = [...css.matchAll(new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`, "g"))];
  assert.ok(all.length > 0, `styles.css 里没有 ${sel}`);
  return all[all.length - 1]![1]!;
};

test("A5 意见卡：标题单独一行，不与严重度、性质、条款位置、状态挤在同一行", () => {
  const w = src("components/ReviewWorkbench.tsx");
  const head = /<button className="rc-head"[\s\S]*?<\/button>/.exec(w)?.[0] ?? "";
  assert.ok(head, "找到卡头");
  // 卡头里先是一整行标签（rc-meta），标题（rc-title）是 rc-meta 之后的兄弟元素，不在 rc-meta 里面
  const meta = /<span className="rc-meta">[\s\S]*?\n {18}<\/span>/.exec(head)?.[0] ?? "";
  assert.ok(meta, "卡头第一行是 rc-meta");
  for (const s of ["rc-sev", "natureText(c)", "rc-ref", "rc-status"]) assert.ok(meta.includes(s), `第一行有 ${s}`);
  assert.ok(!meta.includes("rc-title") && !meta.includes("plain(c.issue)"), "标题不在第一行里");
  assert.match(head, /<\/span>\s*<span className="rc-title">\{plain\(c\.issue\)\}<\/span>\s*<\/button>/, "标题在第一行之后单独一行");
  const css = src("styles.css");
  assert.match(rule(css, ".rc-head"), /flex-direction: column/, "卡头竖排两行");
  assert.match(rule(css, ".rc-title"), /-webkit-line-clamp: 2/, "收起时最多两行");
  assert.match(rule(css, ".rc.open .rc-title"), /display: block/, "展开后标题完整显示");
  assert.match(rule(css, ".rc-meta"), /min-width: 0/);
  assert.match(rule(css, ".rc-ref"), /text-overflow: ellipsis/, "条款位置太长时省略，不挤标题");
});

test("A5 意见卡：展开后“问题判断”不再把标题同一段话再出现一遍", () => {
  const w = src("components/ReviewWorkbench.tsx");
  assert.doesNotMatch(w, /"问题判断"|>问题判断</, "不再有“问题判断”一行");
  const body = /\{open && \(\s*<div className="rc-body">([\s\S]*?)<span className="rc-k">性质<\/span>/.exec(w)?.[1] ?? "";
  assert.ok(body.includes('<span className="rc-k">类别</span>'));
  assert.ok(!body.includes("plain(c.issue)"), "卡片主体第一行不重复 issue");
});

test("A5 工作台头部两层：上层返回 + 合同名 + 进度，下层小字与操作；说明收进提示；快捷键是筛选条右端的小入口", () => {
  const w = src("components/ReviewWorkbench.tsx");
  const top = /<div className="wb-top">([\s\S]*?)<div className="wb-bar">/.exec(w)?.[1] ?? "";
  assert.ok(top.includes("{backLabel}") && top.includes("wb-name") && top.includes("wb-prog"), "上层：返回、合同名、进度");
  assert.ok(top.includes("重大 {progress.high_open} 项待处理"), "进度里重大待处理单独强调");
  assert.ok(!/生成修订稿|导出审查意见表|只看本次任务/.test(top), "上层不放操作");
  const bar = /<div className="wb-bar">([\s\S]*?)\n {6}<\/div>\n {6}\{msg && \(/.exec(w)?.[1] ?? "";
  for (const s of ["wb-meta", "只看本次任务", "导出审查意见表", "意见表 Word", "对外版", "生成修订稿", "<Tip "]) assert.ok(bar.includes(s), `下层有 ${s}`);
  // 两行长说明不再常驻：对外版说明在 ⓘ 提示里，禁用原因放按钮提示 + 一行短字
  assert.ok(!/className="wb-why muted">\s*\{accepted === 0/.test(w));
  assert.match(w, /title=\{redlineWhy\?\.full\}/, "禁用原因在按钮提示里");
  assert.match(w, /先接受或修改后接受至少一项（还有 \$\{openCount\} 项未处理）/);
  // 快捷键入口在筛选条里（wb-filters），不再单独一行
  const filters = /<div className="wb-filters" role="tablist">([\s\S]*?)\n {10}<\/div>/.exec(w)?.[1] ?? "";
  assert.ok(filters.includes('className="wb-keys"') && filters.includes("J / K"), "快捷键在筛选条右端");
  assert.ok(!w.includes('<div className="wb-keys'), "不再有单独一行的快捷键");
  const css = src("styles.css");
  assert.match(rule(css, ".wb-keys"), /margin-left: auto/);
  assert.match(rule(css, ".wb-actions"), /flex-wrap: wrap/, "窄屏时操作换行，不横向溢出");
  assert.match(rule(css, ".wb-meta"), /text-overflow: ellipsis/);
});

test("A6 计划卡折叠：露“怎么审 / 会交出什么 / 需要你决定的事”，“步骤”折起来；认不出标题时露前两节；两节以内不折", () => {
  const plan = "## 怎么审\n立场：委托方。\n\n## 步骤\n1. 读合同\n2. 写风险卡\n\n## 会交出什么\n- 风险卡\n\n## 需要你决定的事\n- 违约金上限";
  const r = splitPlan(plan);
  assert.deepEqual(r.restTitles, ["步骤"]);
  assert.ok(r.head.startsWith("## 怎么审") && r.head.includes("## 会交出什么") && r.head.includes("## 需要你决定的事"));
  assert.ok(!r.head.includes("读合同"));
  assert.ok(r.head.indexOf("会交出什么") < r.head.indexOf("需要你决定"), "保持原文顺序");
  const bold = "**一、背景**\n甲\n**二、范围**\n乙\n**三、安排**\n丙";
  assert.deepEqual(splitPlan(bold).restTitles, ["三、安排"], "没有“会交 / 决定”类标题：露前两节");
  assert.deepEqual(splitPlan("先读材料，再写意见。").restTitles, [], "没有节：不折");
  assert.deepEqual(splitPlan("## 怎么审\n甲\n## 步骤\n乙").restTitles, [], "两节以内：不折");
  assert.deepEqual(splitPlan("开头一句。\n## 会交出什么\n甲\n## 步骤\n乙").restTitles, ["步骤"], "开头无标题的文字算第一节");
  assert.deepEqual(splitPlan("## 甲\n```\n## 不是标题\n```\n## 乙\n## 丙").restTitles, ["丙"], "代码块里的 # 不算节");
});

test("A6 计划卡：主操作在标题行右侧，展开全文后底部再给一次；不再用内滚动框；三种确认卡同一外壳", () => {
  const c = src("components/Cards.tsx");
  assert.match(c, /<div className="cc-top">\s*<div className="cc-head"><Icon\.list \/> 请确认工作计划 \{timer\}<\/div>\s*\{planActions\("top"\)\}/);
  assert.match(c, /<div className="cc-bottom">[\s\S]*?\{planActions\("bottom"\)\}/);
  assert.match(c, /展开全文（另有/);
  assert.match(c, /disabled=\{busy \|\| !feedback\.trim\(\)\}/, "没写意见不能退回（V14 第 39 批）不变");
  assert.match(c, /<div className="cc-top">\s*<div className="cc-head"><Icon\.question \/> 需要你定一下/);
  const o = src("components/OutlineConfirm.tsx");
  assert.match(o, /className="card-confirm card-outline outline-card"/);
  assert.match(o, /<div className="cc-head">起草前请确认/);
  assert.match(o, /<div className="cc-actions">/);
  const css = src("styles.css");
  assert.match(rule(css, ".card-plan .cc-plan"), /max-height: none/);
  assert.match(rule(css, ".card-plan .cc-plan"), /overflow: visible/);
  assert.match(rule(css, ".card-confirm"), /gap: var\(--sp-2\)/);
});

test("A10 材料表：审查意见的待处理数换到第二行，审查意见与时间列不再重叠", () => {
  const m = src("pages/Matter.tsx");
  assert.match(m, /<span className="mat-review-open">待处理 \{/);
  assert.ok(!m.includes("`（待处理 ${review.get(d.document_version_id)!.open}）`"));
  const css = src("styles.css");
  assert.match(rule(css, ".mat-table td:nth-child(5)"), /white-space: normal/);
  assert.match(rule(css, ".mat-table col.c-time"), /width: 124px/);
});
