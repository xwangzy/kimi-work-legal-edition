/**
 * v9.4 第 24 批界面（10-23 拍板）：复核页“论点未经确认”须写理由才能签发；修订署名的对外版说明；问答页写明流式撤回；
 * 被停用电脑启动时只提示清除个人数据；本所范本库（方法与模板页）与审查工作台卡片的“本所范本”；本机流程“不计点”。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveFileParams } = require("../electron/file-dialogs.cjs") as { resolveFileParams: (m: string, p: unknown, s: { take: (h: unknown, kind: string) => string | null }) => any };

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("复核页：有“论点未经确认”时出理由输入框，理由不足 4 字时“确认签发”不可点，理由随签发提交", () => {
  const r = src("pages/Review.tsx");
  assert.match(r, /const outlineOpen = data\?\.outline_unconfirmed === true;/);
  assert.match(r, /outlineOpen && \(\s*<label className="field review-reason">/);
  assert.match(r, /aria-label="不确认论点就签发的理由"/);
  // 字数与内核同一算法（压空白后计，复核 Q6-09）
  assert.match(r, /\(outlineOpen && \[\.\.\.outlineReason\.replace\(\/\\s\+\/g, " "\)\.trim\(\)\]\.length < 4\)/);

  assert.match(src("components/OutlineConfirm.tsx"), /签发时须写明不确认的理由/);
});

test("修订署名：没填时说明对外版用本所名称、内部版用缺省写法", () => {
  const d = src("components/DocStyle.tsx");
  assert.match(d, /不填时：对外版用本所名称“\$\{v\.firm_name\}”，内部版用括号里的缺省写法。/);
});

test("问答页写明流式回答被内容安全规则拦下时会撤回（D-142）", () => {
  assert.match(src("pages/Chat.tsx"), /回答边生成边显示；如果被内容安全规则拦下，已经显示的部分会撤回，改为“未能取得回答”，这次回答不保存。\s*<\/details>/);
});

test("被停用的电脑：启动时提示、律师点了才清除（不自动清除），可以先不清除", () => {
  const a = src("App.tsx");
  assert.match(a, /members\s*\.personalStatus\(\)/);
  assert.match(a, /s\.prompt_clear \?/);
  assert.match(a, /清除我的个人数据/);
  assert.match(a, /先不清除/);
  // 只有按钮里调清除
  assert.equal(a.match(/offboardClearPersonal\(\)/g)?.length, 1);
});

test("本所范本库：方法与模板页有入口；放入走系统对话框句柄（渲染进程带的路径剥掉）；查到客户信息先列出、可换占位符", () => {
  const m = src("pages/Methods.tsx");
  assert.match(m, /<FirmTemplates \/>/);
  const f = src("components/FirmTemplates.tsx");
  assert.match(f, /换成占位符后放入/);
  assert.match(f, /返回修改/);
  // 如实写明哪些会发给 AI（复核 Q6-02、Q6-06）：范本库本身不发，照着改并接受的文字、放进事项的范本会随任务发出
  assert.match(f, /范本库本身不发给 AI，但你照着改并接受的文字、放进事项的范本，会和事项里其他内容一样随任务发给 AI。/);
  assert.match(f, /没在你事项里的客户名称查不出来/);
  // 放进事项：律师自己选事项；说明选用后会随任务发给 AI
  assert.match(f, /api\.firmTemplateToMatter\(templateId, to\)/);
  assert.match(f, /放进去后，这个事项里的 AI 任务可以读取它（会随任务发给 AI）/);
  const store = { take: (h: unknown, kind: string) => (h === "h1" && kind === "open" ? "/Users/x/范本.docx" : null) };
  assert.deepEqual(resolveFileParams("firm_templates.add", { file_handle: "h1", filename: "范本.docx", file: "/etc/passwd", title: "t" }, store).params, { filename: "范本.docx", file: "/Users/x/范本.docx", title: "t" });
  assert.ok(resolveFileParams("firm_templates.add", { file_handle: "bad" }, store).error);
});

test("审查工作台：卡片展开时取本所范本，写明“本所范本”、立场不同标出，未处理的卡可“照这条改”（放进修改框，不直接接受）", () => {
  const w = src("components/ReviewWorkbench.tsx");
  assert.match(w, /api\s*\.templatesForCard\(matterId, id\)/);
  assert.match(w, /<span className="rc-k">本所范本<\/span>/);
  assert.match(w, /立场不同/);
  // 占位符换成本合同的写法前不能保存（复核 Q6-12）
  assert.match(w, /disabled=\{busy \|\| !editing\.text\.trim\(\) \|\| PLACEHOLDER\.test\(editing\.text\)\}/);
  assert.match(w, /onClick=\{\(\) => setEditing\(\{ id: c\.card_id, text: m\.body \}\)\}/);
  assert.match(w, /!readOnly && c\.status === "proposed" && \(\s*<button className="btn-link" disabled=\{busy\} aria-label=\{`照《\$\{m\.title\}》\$\{m\.heading\}改`\}/);
});
