/**
 * 侧栏用户卡（复核 R15B-23）：取不到内核状态时说“正在连接…”；状态点能显示（行内元素要 inline-block）；侧栏收窄时状态点挂在头像上。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sidebarFoot, userCardText } from "../src/lib/user-card.ts";

test("用户卡文字：还没取到状态时不说“本机 / 开发形态”；悬停提示带本机状态", () => {
  const foot = { title: "有联网记录需要核对", note: "2 条因中断无法确认是否发出" };
  const pending = userCardText(null, foot);
  assert.equal(pending.name, "正在连接…");
  assert.equal(pending.firm, null);
  assert.equal(pending.tooltip, "设置 · 有联网记录需要核对：2 条因中断无法确认是否发出");
  assert.deepEqual(userCardText({ name: "张三", firm: "某某律师事务所" }, { title: "本机运行 · 防护正常", note: "" }), {
    name: "张三",
    firm: "某某律师事务所",
    avatar: "张",
    tooltip: "设置 · 本机运行 · 防护正常",
  });
  assert.equal(userCardText({ name: null, firm: null }, foot).firm, "开发形态", "确实没有激活记录才是开发形态");
});

test("样式：状态点 inline-block；头像上的状态点只在收窄（图标栏、窄窗口）时显示", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
  assert.match(css, /^\.dot \{ display: inline-block;/m);
  assert.match(css, /\.sidebar-foot \.avatar-dot \{ display: none; position: absolute;/);
  assert.match(css, /\.sidebar\.compact \.sidebar-foot \.avatar-dot \{ display: block; \}/);
  const narrow = css.slice(css.indexOf("@media (max-width: 900px)"));
  assert.match(narrow.slice(0, narrow.indexOf("\n}")), /\.sidebar \.sidebar-foot \.avatar-dot \{ display: block; \}/);
  const src = readFileSync(fileURLToPath(new URL("../src/components/Sidebar.tsx", import.meta.url)), "utf8");
  assert.match(src, /className=\{`dot avatar-dot \$\{footTone\}`\}/);
  assert.match(src, /title=\{card\.tooltip\}/);
});

test("用户卡底部一行（v9.3 B-3 余项）：有入组申请等批准时亮橙点、点开到“管理 · 成员”；联网记录需要核对更要紧", () => {
  const ok = { gate: true, unresolved: 0, execOk: true, pendingJoins: 0 };
  assert.deepEqual(sidebarFoot(ok), { title: "本机运行 · 防护正常", note: "", tone: "dot-ok", href: "/connections" });
  const joins = sidebarFoot({ ...ok, pendingJoins: 2 });
  assert.equal(joins.tone, "dot-warn");
  assert.equal(joins.title, "有 2 位同事等你批准入组");
  assert.equal(joins.href, "/connections/admin");
  const both = sidebarFoot({ ...ok, pendingJoins: 2, unresolved: 1 });
  assert.equal(both.title, "有联网记录需要核对");
  assert.equal(both.href, "/connections/device");
  assert.equal(sidebarFoot({ ...ok, gate: null, pendingJoins: 3 }).tone, "dot-off", "启动中不提前报");
  assert.equal(sidebarFoot({ ...ok, execOk: false }).note, "其余功能正常");
});
