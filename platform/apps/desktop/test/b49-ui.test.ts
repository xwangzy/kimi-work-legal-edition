/**
 * 第 49 批：侧栏收起根因修复、成果页信息架构、数据去向对照表、全局搜索找材料（替代单独的本地工作空间）、品牌字标统一。
 * 纯函数逐条断言；页面与样式用源文件静态检查锁住根因（与 b48-ui 同一做法）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("侧栏状态唯一来源：手动收起记偏好；执行态与窄窗口自动收起，可临时展开", async () => {
  const { sidebarState } = await import("../src/lib/sidebar-state.ts");
  assert.deepEqual(sidebarState({ collapsedPref: false, forced: false, narrow: false, peek: false }), { compact: false, auto: false });
  assert.deepEqual(sidebarState({ collapsedPref: true, forced: false, narrow: false, peek: false }), { compact: true, auto: false });
  // 执行态 / 窄窗口：缺省收起，不看偏好；peek 临时展开
  assert.deepEqual(sidebarState({ collapsedPref: false, forced: true, narrow: false, peek: false }), { compact: true, auto: true });
  assert.deepEqual(sidebarState({ collapsedPref: false, forced: false, narrow: true, peek: true }), { compact: false, auto: true });
  // peek 不影响非自动收起的状态
  assert.deepEqual(sidebarState({ collapsedPref: true, forced: false, narrow: false, peek: true }), { compact: true, auto: false });
});

test("侧栏样式根因：不再用媒体查询另改侧栏；竖排 Work/Chat 选项 flex: none；收起时不裁切账号菜单", () => {
  const css = src("styles.css");
  // ① 窄窗口规则不再直接改 .sidebar（收起只认 .compact，由组件按窗口宽度算）
  for (const block of css.match(/@media \(max-width: 900px\) \{[\s\S]*?\n\}/g) ?? []) {
    assert.doesNotMatch(block, /\.sidebar[\s.{]/, "窄窗口媒体查询里不应再出现侧栏规则");
  }
  // ② 竖排时选项必须 flex: none，否则 flex: 1 的基准 0% 把高度压扁、两个图标叠在一起（第 48 批截图里的现象）
  assert.match(css, /\.sidebar\.compact \.mode-tab \{[^}]*flex: none;[^}]*height: 32px/);
  // ③ 收起时 overflow: visible，240px 宽的账号菜单不被裁成 52px 一条
  assert.match(css, /\.sidebar\.compact \{[^}]*overflow: visible/);
  // ④ 图标两种状态横向位置不变：条目内边距 9px、收起宽 52px、条目 36px
  assert.match(css, /\.nav-item \{ padding: 0 9px; \}/);
  assert.match(css, /\.sidebar\.compact \{ width: 52px; flex-basis: 52px;/);
  assert.match(css, /\.sidebar\.compact \.nav-item \{ width: 36px;/);
  // 收起时 ⌘K 键帽与文字都隐藏（旧窄窗口规则漏了键帽）
  assert.match(css, /\.sidebar\.compact \.nav-label, \.sidebar\.compact \.nav-kbd/);
  const sb = src("components/Sidebar.tsx");
  assert.match(sb, /sidebarState\(\{ collapsedPref: collapsed, forced, narrow, peek \}\)/);
  assert.match(sb, /matchMedia\(NARROW_QUERY\)/);
  // 收起时也能搜索、能回到全部事项
  assert.match(sb, /nav-rail-only nav-rail-search/);
  assert.match(sb, /nav\("\/matters"\)\} title="全部事项"/);
});

test("成果：待处理 = 草稿 + 待复核 + 退回；页首一句话先说等你处理的是什么", async () => {
  const { inFilter, deliverablesSummary } = await import("../src/lib/deliverables.ts");
  assert.equal(inFilter("draft", "todo"), true);
  assert.equal(inFilter("pending_review", "todo"), true);
  assert.equal(inFilter("rejected", "todo"), true);
  assert.equal(inFilter("approved", "todo"), false);
  assert.equal(inFilter("approved", "approved"), true);
  assert.equal(inFilter("superseded", "all"), true);
  assert.equal(deliverablesSummary({ pending_review: 2, draft: 4, rejected: 0, approved: 1 }), "2 份等你复核签发，4 份草稿还没复核");
  assert.equal(deliverablesSummary({ pending_review: 0, draft: 0, rejected: 1, approved: 0 }), "1 份被退回待修改");
  assert.equal(deliverablesSummary({ pending_review: 0, draft: 0, rejected: 0, approved: 5 }), "都已签发，共 5 份");
  assert.match(deliverablesSummary({ pending_review: 0, draft: 0, rejected: 0, approved: 0 }), /还没有成果/);
});

test("成果：同族文件的共同前缀淡化、差异突出；名称不同的文件不受影响", async () => {
  const { nameParts } = await import("../src/lib/deliverables.ts");
  const stem = "冷链智能分拣系统采购与实施合同（棠溪智能提供稿）";
  const names = ["审查意见书（内部稿）-冷链智能分拣系统采购与实施合同", "问题清单-冷链智能分拣系统采购与实施合同", `${stem}（修订稿）`, `${stem}（清洁稿）`, `${stem}（修改对照表）`];
  const p = nameParts(names);
  assert.deepEqual(p.get(`${stem}（修订稿）`), { head: stem, tail: "（修订稿）" });
  assert.deepEqual(p.get(`${stem}（修改对照表）`), { head: stem, tail: "（修改对照表）" });
  assert.equal(p.get(names[0]!)!.head, "", "没有同族文件的名称不拆");
  assert.equal(p.get(names[1]!)!.head, "");
  // 前缀太短或断不开的不拆；拆完必须还有差异
  assert.equal(nameParts(["补证清单", "补证说明"]).get("补证清单")!.head, "");
  for (const [n, v] of p) assert.equal(v.head + v.tail, n, "拼回去就是原名");
});

test("成果页接线：一个事项一张卡片、单行文件、第 N 版合并版本记录、计数为 0 不显示数字", () => {
  const page = src("pages/Deliverables.tsx");
  assert.match(page, /\["todo", "待处理"\]/);
  assert.match(page, /className="dl-card"/);
  assert.match(page, /\{count\(k\) > 0 && <span className="dl-tab-n">/);
  assert.match(page, /nameParts\(t\.files\.map/);
  const row = src("components/ArtifactRow.tsx");
  assert.match(row, /className="dl-ver" aria-expanded=\{open\}/);
  assert.doesNotMatch(row, /版本记录（\{entry\.older\.length\}）/, "“版本记录（n）”已并入“第 N 版”");
  assert.match(row, /import "\.\.\/styles-deliverables\.css";/);
});

test("数据去向：对照表 + 可展开的说明行（打印时全部展开）；客户授权在最上面且不打印；口径逐条保留", () => {
  const page = src("pages/Connections.tsx");
  const vis = page.slice(page.indexOf("function VisibilityTab"), page.indexOf("function sampleParts"));
  assert.match(vis, /className="dfx-table"/);
  assert.ok(vis.indexOf("<AuthorizationDefault />") < vis.indexOf('className="dfx-table"'), "客户授权在对照表之前");
  assert.match(vis, /addEventListener\("beforeprint"/);
  for (const phrase of ["案卷原件与全部成果", "代号与真实姓名的对照表", "只转发，不保存", "“不用于训练、不保留”的书面确认：待签署", "请求编号、模型、token 数、金额", "识别会遗漏", "客户可以拒绝", "不经中软的情形", "电脑账户", "未启用的功能", "按原文发送"]) {
    assert.ok(vis.includes(phrase), `口径保留：${phrase}`);
  }
  assert.match(page, /className="dfx-auth no-print"/);
});

test("全局搜索找材料：分组“材料”，点开交给事项页切到材料并筛出这份（只在内存里交接，5 秒内重挂载不丢）", async () => {
  const { searchGroups, takeMatterFocus, SEARCH_KIND_LABEL } = await import("../src/lib/search.ts");
  assert.equal(SEARCH_KIND_LABEL.material, "材料");
  const g = searchGroups({ matters: [], runs: [], deliverables: [], materials: [{ document_version_id: "d1", matter_id: "m1", matter_title: "幕墙分包欠款案", filename: "分包合同.docx", rel_path: "合同/分包合同.docx", created_at: "2026-11-20T00:00:00Z" }] });
  const it = g.find((x) => x.kind === "material")!.items[0]!;
  assert.equal(it.href, "/matter/m1");
  assert.equal(it.sub, "幕墙分包欠款案 · 合同");
  assert.deepEqual(it.focus, { matterId: "m1", q: "分包合同.docx" });
  // 旧内核没有 materials：不报错、没有这一组
  assert.equal(searchGroups({ matters: [], runs: [], deliverables: [] }).length, 0);
  const { peekMatterFocus, setMatterFocus } = await import("../src/lib/search.ts");
  const t0 = 1_000_000;
  setMatterFocus(it.focus!, t0);
  assert.equal(peekMatterFocus("m2", t0), null, "别的事项不取");
  assert.equal(peekMatterFocus("m1", t0), "分包合同.docx");
  // 首次载入时页面重挂载：5 秒内同一事项仍是同一个词；之后失效
  assert.equal(takeMatterFocus("m1", t0 + 1000), "分包合同.docx");
  assert.equal(peekMatterFocus("m1", t0 + 6000), null);
  // 只在内存里交接，不用浏览器存储（渲染存储门禁）
  assert.doesNotMatch(src("lib/search.ts") + src("components/SearchPalette.tsx"), /sessionStorage|localStorage/);
});

test("品牌：首页小标与侧栏字标、安装包名称一致为“法律版”", () => {
  assert.match(src("pages/Home.tsx"), /<span className="home-wordmark-tag">法律版<\/span>/);
  assert.match(src("components/Brand.tsx"), /edition = "法律版"/);
});
