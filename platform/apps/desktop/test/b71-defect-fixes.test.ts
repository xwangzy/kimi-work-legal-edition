/**
 * 第 71 批：第 70 批验收缺陷 D1、D2、D7、D10、D11、D12 的根因用例（复核页系统已核对、劳动仲裁答辩卡我方地位、接着做胶囊、
 * 用量页问答标题、开通的最后一步）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { citationsCheck, materialsCheck, systemChecks } from "../src/lib/system-checks.ts";
import { clipByWidth, whereView, WHERE_TITLE_WIDTH } from "../src/lib/personal-usage.ts";
import { clientKindOf, deliverableSubtitle, materialsShort, preselectDocs, SCENARIOS, sideOptionFor, stanceChipText } from "../src/lib/scenarios.ts";
import { cnDateLabel, normalizeDateInput } from "../src/lib/date-input.ts";
import { materialsLine } from "../src/lib/labels.ts";
import { stanceMismatchText } from "../src/lib/card-layout.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");

test("D1：没勾材料时按实际读过的份数写，不再出现“已读 0/0 份”绿勾", () => {
  // 第 70 批验收原样：内核以前给 { loaded: 0, requested: 0 } → “已读 0/0 份”且 ok=true
  const all = materialsCheck({ on_demand: true, tracked: true, total: 3, read: 3, unread_files: [] });
  assert.equal(all.ok, true);
  assert.equal(all.text, "已读 3/3 份（没有勾选：本事项全部材料）");
  const part = materialsCheck({ on_demand: true, tracked: true, total: 3, read: 2, unread_files: ["03-收款记录.xlsx"] });
  assert.equal(part.ok, null, "读了一部分：只陈述、不打勾也不标红（没勾材料不设边界，不是材料缺口）");
  assert.equal(part.text, "已读 2/3 份（没有勾选：按需读取），没读：《03-收款记录.xlsx》");
  const none = materialsCheck({ on_demand: true, tracked: true, total: 3, read: 0, unread_files: ["a", "b", "c"] });
  assert.equal(none.ok, null);
  assert.match(none.text, /^已读 0\/3 份/);
  assert.equal(materialsCheck({ on_demand: true, tracked: true, total: 0, read: 0, unread_files: [] }).text, "没有勾选材料，本事项也没有材料");
  // 老任务没有逐份读取记录：如实说，不打勾
  const legacy = materialsCheck({ on_demand: true, tracked: false });
  assert.equal(legacy.ok, null);
  assert.match(legacy.text, /没有逐份读取记录/);
  // 勾了材料：照旧
  assert.deepEqual(materialsCheck({ loaded: 3, requested: 3, failed: 0 }), { label: "材料读取", ok: true, text: "已读 3/3 份" });
  assert.deepEqual(materialsCheck({ loaded: 2, requested: 3, failed: 1 }), { label: "材料读取", ok: false, text: "已读 2/3 份，1 份没有读到", fix: "materials" });
  assert.equal(materialsCheck({ note: "非任务产出" }).text, "不是任务产出（无材料读取记录）");
  // 任何形态都不会出现 0/0
  for (const m of [{ on_demand: true, tracked: true, total: 0, read: 0, unread_files: [] }, { on_demand: true, tracked: false }]) assert.doesNotMatch(materialsCheck(m).text, /0\/0/);
});

test("D2：引用核验与下方“论断与依据”、签发门禁同源（成果自身的核验），不再在列出 10 处已核引用时写“没有引用核验记录”", () => {
  // 第 70 批验收原样：运行级 citations 只有 note（Agent 任务不写 citations.verified），成果核验 10 处、来源版本都核到、支持性待判
  const ac = { checked: true, total: 10, verified: 10, wrong: 0, unverified_offline: 0, outside_registry: 0, timing: 0, support_pending: 10, unsupported: 0, items: [] };
  const c = citationsCheck(ac, { note: "无引用核验记录" });
  assert.equal(c.ok, true);
  assert.equal(c.text, "共 10 处，来源与版本已核 10 处；支持性待你逐条确认 10 处");
  assert.doesNotMatch(c.text, /没有引用核验记录/);
  // 有问题的标红并给处理入口
  const bad = citationsCheck({ ...ac, verified: 7, wrong: 1, outside_registry: 2, support_pending: 0 }, null);
  assert.equal(bad.ok, false);
  assert.equal(bad.fix, "citations");
  assert.equal(bad.text, "共 10 处，来源与版本已核 7 处，1 处核对不通过，2 处不在本机法规库、须人工核对");
  // 系统没核对这份文件
  const unchecked = citationsCheck({ checked: false, unchecked_reason: "format", total: 0, items: [] }, null);
  assert.equal(unchecked.ok, false);
  assert.match(unchecked.text, /系统没有核对这份文件里的引用（格式不认识）/);
  // 成果里没有引用
  assert.deepEqual(citationsCheck({ checked: true, total: 0, items: [], wrong: 0, unverified_offline: 0, outside_registry: 0 }, null), { label: "引用核验", ok: null, text: "成果里没有法规或案号引用" });
  // 材料核验（合同审查默认路径）拦下的另写一句
  assert.match(citationsCheck({ ...ac, support_pending: 0 }, { total: 4, intercepted: 1, unverified_offline: 0 }).text, /材料里另有 1 条被拦下/);
  // 老内核没有成果核验：退回运行级
  assert.equal(citationsCheck(undefined, { total: 3, intercepted: 0, unverified_offline: 0, as_of: "2026-11-26" }).text, "共 3 条（法规版本截至 2026-11-26）");
  assert.equal(citationsCheck(undefined, { note: "无引用核验记录" }).text, "本成果没有引用核验记录");
  // 整张单：两项都来自同一份完整性单
  const checks = systemChecks({ materials: { on_demand: true, tracked: true, total: 3, read: 3, unread_files: [] }, citations: { note: "无引用核验记录" }, artifact_citations: ac, file_integrity: "ok", audience_check: "内部稿（不得外发）" }, true);
  assert.deepEqual(checks.slice(0, 2).map((x) => [x.label, x.ok]), [["材料读取", true], ["引用核验", true]]);
  // 复核页用的是这份纯函数，运行页材料弹层不再写 0/0
  assert.match(src("pages/Review.tsx"), /systemChecks\(data\.completeness, latest\)/);
  assert.match(src("pages/RunView.tsx"), /loaded && Number\(loaded\.requested\) > 0 && /);
});

test("D7：劳动仲裁答辩卡在“原告”事项上——按委托人推断用人单位 / 劳动者；推断不了时面板顶部不硬写与卡片不符的立场", () => {
  const labor = SCENARIOS.find((c) => c.id === "labor-arb-defense-lit")!.fields.find((f) => f.key === "side")!.options!;
  assert.deepEqual(labor, ["用人单位", "劳动者"]);
  assert.equal(sideOptionFor(labor, "原告", "苏州锐川精密机械有限公司"), "用人单位");
  assert.equal(sideOptionFor(labor, "申请人", "王小明"), "劳动者");
  assert.equal(sideOptionFor(labor, "原告", null), null, "看不出委托人是谁：不猜");
  assert.equal(sideOptionFor(labor, "原告"), null, "不给委托人时与原先一致");
  assert.equal(sideOptionFor(["原告 / 申请人", "被告 / 被申请人"], "原告", "某某有限公司"), "原告 / 申请人", "诉讼卡不受委托人推断影响");
  assert.equal(sideOptionFor(["原告 / 申请人", "被告 / 被申请人"], "plaintiff"), "原告 / 申请人", "英文代码立场也能对上");
  assert.equal(clientKindOf("嘉兴禾丰包装科技有限公司"), "org");
  assert.equal(clientKindOf("林某某律师事务所"), "org");
  assert.equal(clientKindOf("陈立"), "person");
  assert.equal(clientKindOf("Acme Ltd"), null);
  // 面板顶部
  assert.equal(stanceChipText(["原告 / 申请人", "被告 / 被申请人"], "原告", "原告", null), "我方 原告");
  assert.equal(stanceChipText(labor, "原告", "原告", "苏州锐川精密机械有限公司"), "我方 原告（用人单位）");
  assert.equal(stanceChipText(labor, "原告", "原告", null), "事项立场 原告 · 本卡请另选我方地位");
  assert.equal(stanceChipText(undefined, "原告", "原告", null), "我方 原告", "没有我方地位下拉的卡照旧");
  assert.equal(stanceChipText(labor, "劳动者", "劳动者", null), "我方 劳动者");
  // 原告事项上开答辩卡：中文立场也提醒（原先只认英文代码 plaintiff，验收截图里没有提醒）
  assert.match(stanceMismatchText("labor-arb-defense-lit", "原告")!, /这个事项我方是原告；答辩书通常由被告 \/ 被申请人一方提交/);
  assert.match(stanceMismatchText("defense", "plaintiff")!, /我方是原告；答辩状/);
  assert.match(stanceMismatchText("pleading", "被告")!, /我方是被告/);
  assert.equal(stanceMismatchText("labor-arb-defense-lit", "劳动者"), null);
  assert.equal(stanceMismatchText("labor-arb-defense-lit", "被申请人"), null);
  const ss = src("components/ScenarioStart.tsx");
  assert.match(ss, /sideOptionFor\(sideField\.options, matter\?\.stance, matter\?\.client_name\)/);
  assert.match(ss, /stanceChipText\(sideField\?\.options, stanceLabel\(matter\.stance\), matter\.stance, matter\.client_name\)/);
});

test("D10：任务页“接着做”胶囊（.pill-link）不再用蓝色强调色，与其他胶囊同为中性色", () => {
  const css = src("styles.css");
  const rule = css.match(/\n\.pill-link \{([^}]*)\}/)?.[1] ?? "";
  assert.ok(rule, "找得到 .pill-link 规则");
  assert.doesNotMatch(rule, /accent/);
  assert.match(rule, /color: var\(--text-primary\)/);
  assert.match(rule, /border-color: var\(--border-subtle\)/);
  assert.match(src("pages/RunView.tsx"), /className="pill pill-link" onClick=\{\(\) => nav\(`\/start\//);
});

test("D11：问答标题按显示宽度截断、去掉末尾标点、加省略号，悬停给全称", () => {
  // 第 70 批验收原样：内核存的会话标题是第一问的前 24 字，断在“，”上
  const stored = "买卖合同纠纷中，买方逾期付款的违约金约定过高时，";
  assert.equal([...stored].length, 24);
  const fullAsk = "买卖合同纠纷中，买方逾期付款的违约金约定过高时，法院如何调整？请列明依据。";
  const w = whereView({ task: "问答", matter: stored, matter_full: fullAsk, matter_id: null, run_id: null, conversation_id: "qac_1", how: "id" } as any)!;
  assert.equal(w.full, fullAsk, "悬停给第一问全文");
  assert.ok(w.main.endsWith("…"));
  assert.doesNotMatch(w.main, /[，,。；;：:]…$/, "省略号前不留标点");
  assert.equal(w.main, "买卖合同纠纷中，买方逾期付款的违约金约定过高时…");
  // 老内核没有 matter_full：标题恰好 24 字按“被截过”处理
  const old = whereView({ task: "问答", matter: stored, matter_id: null, run_id: null, conversation_id: "qac_1", how: "id" } as any)!;
  assert.equal(old.main, "买卖合同纠纷中，买方逾期付款的违约金约定过高时…");
  assert.equal(old.full, stored);
  // 短标题原样、不加省略号
  const short = whereView({ task: "问答", matter: "违约金怎么算", matter_id: null, run_id: null, conversation_id: "qac_2", how: "id" } as any)!;
  assert.equal(short.main, "违约金怎么算");
  // 按显示宽度：半角字母算 1，能放得下更多
  assert.equal(clipByWidth("a".repeat(WHERE_TITLE_WIDTH), WHERE_TITLE_WIDTH), "a".repeat(WHERE_TITLE_WIDTH));
  assert.equal(clipByWidth("汉".repeat(30), WHERE_TITLE_WIDTH), `${"汉".repeat(23)}…`);
  assert.equal(clipByWidth("第一句，第二句", 8, true), "第一句…");
  // 任务行的悬停仍是“卡片名 · 事项名”
  assert.equal(whereView({ task: "诉讼成本与回收测算", matter: "锐川诉禾丰", matter_id: "m", run_id: "r", conversation_id: null, how: "id" } as any)!.full, "诉讼成本与回收测算 · 锐川诉禾丰");
  assert.match(src("pages/PersonalUsage.tsx"), /title=\{w\.full \?\?/);
});

test("D12：开通的最后一步——上方只留一句为什么，三步只在卡片里列一次；“以后再说”与说明同一行居中", () => {
  const page = src("pages/Welcome.tsx");
  assert.doesNotMatch(page, /className="welcome-steps"/, "上方不再重复列 1/2/3 三步");
  assert.match(page, /className=\{`welcome-why \$\{allDone \? "is-ok" : "is-warn"\}`\} role="status">\{welcomeHeadline\(steps\)\.replace\(\/\^还差/, "去掉“还差 n 步”，与标题不矛盾；提示行有状态样式");
  assert.match(page, /who\.name && !who\.firm\.includes\(who\.name\)/, "工作室名里已有姓名时不重复");
  assert.match(src("styles.css"), /\.welcome-wrap \{[^}]*justify-content: center;/);
  assert.doesNotMatch(page, /开通的最后一步<\/h1>/);
  assert.match(page, /<RecoveryBackup onChanged=\{\(\) => void load\(\)\} footer=\{actions\} \/>/, "“以后再说”放回卡内");
  const rb = src("components/RecoveryBackup.tsx");
  assert.doesNotMatch(rb, /<span>文件位置（恢复包文件或备份文件夹）<\/span>/, "文件位置不再单独一栏");
  assert.match(rb, /"选择位置…"/);
  assert.match(page, /className="settings-choice welcome-actions"/);
  assert.match(src("styles.css"), /\.settings-choice\.welcome-actions \{ align-items: center;/);
});

test("区域 6：日期栏中文写法（不出现 mm/dd/yyyy），“我方地位”统一下拉、排第一，副标题不重复卡名，滚动区底部渐隐", () => {
  assert.equal(normalizeDateInput("2026-12-15"), "2026-12-15");
  assert.equal(normalizeDateInput("2026/12/5"), "2026-12-05");
  assert.equal(normalizeDateInput("2026.1.5"), "2026-01-05");
  assert.equal(normalizeDateInput("2026年12月15日"), "2026-12-15");
  assert.equal(normalizeDateInput("20261215"), "2026-12-15");
  assert.equal(normalizeDateInput(" "), "");
  assert.equal(normalizeDateInput("12/15/2026"), null, "美式月/日/年不认，免得月日填反");
  assert.equal(normalizeDateInput("2026-02-30"), null);
  assert.equal(cnDateLabel("2026-12-15"), "2026 年 12 月 15 日（星期二）");
  const ss = src("components/ScenarioStart.tsx");
  assert.doesNotMatch(ss, /type=\{f\.kind === "date" \? "date"/, "开始面板不再用原生日期框显示");
  assert.match(ss, /<DateField label=\{f\.label\}/);
  assert.doesNotMatch(src("components/DateField.tsx") + src("lib/date-input.ts"), /placeholder="mm/);
  // 我方地位：全库都是下拉框，且在有它的卡里排第一
  for (const c of SCENARIOS) {
    const i = c.fields.findIndex((f) => f.key === "side");
    if (i < 0) continue;
    assert.equal(c.fields[i]!.kind, "select", `${c.id} 的我方地位应为下拉框`);
    assert.equal(i, 0, `${c.id} 的我方地位应排第一`);
  }
  const lawCase = SCENARIOS.find((c) => c.id === "case-law")!.fields.find((f) => f.key === "side")!;
  assert.equal(sideOptionFor(lawCase.options, "原告"), "原告 / 申请人", "类案检索也按事项立场预选");
  assert.ok(lawCase.options!.includes("只做研究（不选立场）"));
  // 副标题
  const budget = SCENARIOS.find((c) => c.id === "litigation-budget")!;
  const sub = deliverableSubtitle(budget);
  assert.match(sub, /^诉讼仲裁 · 交付：/);
  assert.ok(!sub.includes(`、${budget.title}`) && !sub.endsWith(budget.title), sub);
  assert.match(deliverableSubtitle({ line: "litigation", title: "X", gets: ["劳动仲裁答辩书（草稿）.docx", "证据目录.xlsx（附件）"] }), /^诉讼仲裁 · 交付：劳动仲裁答辩书（Word）、证据目录（Excel）$/);
  assert.match(src("styles-start.css"), /\.modal-card \.modal-actions-sticky::before \{[^}]*linear-gradient/);
});

test("区域 6 / 8：“全部材料”只用一种表示——全勾与一份不勾都写“全部 n 份”，确认框、任务页、复核页同一口径；不需要材料的卡仍不预选（不改读取行为，主 Agent 拍板）", () => {
  const docs = [{ document_version_id: "a", filename: "01.docx" }, { document_version_id: "b", filename: "03.xlsx" }, { document_version_id: "c", filename: "04.docx" }];
  for (const id of ["litigation-budget", "case-analysis", "hearing-outline", "case-law", "labor-arb-defense-lit"]) {
    const card = SCENARIOS.find((c) => c.id === id)!;
    assert.deepEqual(preselectDocs(card, docs), card.minMaterials === 0 ? [] : ["a", "b", "c"], `${id}：minMaterials 0 不预选（没勾 = 按需读取全部），其余默认勾上全部`);
  }
  assert.equal(materialsShort(3, 3), "全部 3 份");
  assert.equal(materialsShort(0, 3), "全部 3 份", "一份不勾（D-183）也是全部");
  assert.equal(materialsShort(2, 3), "已选 2/3 份");
  assert.equal(materialsLine(0), "全部（没有勾选：本事项的材料都可读）");
  assert.match(src("pages/RunView.tsx"), /"材料：全部 ▾"/);
  assert.equal(materialsCheck({ loaded: 3, requested: 3, failed: 0 }).text, "已读 3/3 份");
  assert.match(materialsCheck({ on_demand: true, tracked: true, total: 3, read: 3, unread_files: [] }).text, /^已读 3\/3 份/);
});

test("区域 3：同一单任务（同一运行）同一天连着的计入调用合成一行“N 次调用”；不同运行、对不上用在哪的照旧；固定列与悬停“›”", async () => {
  const { collapseFree } = await import("../src/lib/personal-usage.ts");
  const where = (run: string) => ({ task: "诉讼成本与回收测算", matter: "锐川诉禾丰", matter_id: "m1", run_id: run, conversation_id: null, how: "id" as const });
  const row = (at: string, ratio: number, w: unknown) => ({ at, kind: "task" as const, alias: "legal/k3", label: "K3", tokens_in: 0, tokens_cached: 0, tokens_out: 0, outcome: "ok", partial: false, estimated: false, charge_ratio: ratio, where: w });
  const rows = [row("2026-11-26T11:28:00Z", 0.004, where("r1")), row("2026-11-26T11:21:00Z", 0.004, where("r1")), row("2026-11-26T11:15:00Z", 0.002, where("r1")), row("2026-11-26T11:14:00Z", 0.003, where("r2")), row("2026-11-26T11:10:00Z", 0.001, null), row("2026-11-26T11:02:00Z", 0.001, null)];
  const c = collapseFree(rows as never, 1);
  assert.deepEqual(c.map((x) => [x.n, x.charge.text]), [[3, "1%"], [1, "0.3%"], [1, "0.1%"], [1, "0.1%"]]);
  const page = src("pages/PersonalUsage.tsx");
  assert.match(page, /<span className="pu-runs">/);
  assert.match(page, /<span className="pu-go" aria-hidden="true">/);
  const css = src("styles-usage.css");
  assert.match(css, /\.pu-day-rows li \{ display: grid; grid-template-columns: 48px 44px minmax\(0, 1fr\) 72px 64px 92px 12px;/);
  assert.doesNotMatch(css, /\.pu-kind-tag\.kind-qa \{/, "任务、问答标签同一样式");
  assert.match(css, /\.pu-runs \{[^}]*tabular-nums/);
});

test("区域 2：删除收进“…”菜单并二次确认；回答下方常驻复制 / 重新回答；顶部与底部重复提示只留一条；回答列与输入框同宽", () => {
  const chat = src("pages/Chat.tsx");
  assert.doesNotMatch(chat, /<button className="btn-link" onClick=\{\(\) => setAskDelete\(true\)\}>删除这个问答<\/button>/);
  assert.match(chat, /aria-label="更多操作"/);
  assert.match(chat, /className="chat-menu-danger" onClick=\{\(\) => \{ setMenuOpen\(false\); setAskDelete\(true\); \}\}/);
  assert.match(chat, /删除后找不回来。/);
  assert.match(chat, /\{copied === m\.message_id \? "已复制" : "复制"\}/);
  assert.match(chat, /重新回答/);
  assert.doesNotMatch(chat, /className="chat-notice"/, "顶部提示条去掉，只留输入框下面一条");
  assert.doesNotMatch(chat, /一般法律问题直接问/, "顶部那句重复提示去掉了");
  assert.match(chat, /<div className="chat-scope-note">\s*\{CHAT_SCOPE_NOTE\}/);
  assert.match(src("styles.css"), /\.msg\.msg-assistant \{ max-width: 100%; width: 100%; \}/);
});

test("区域 8：结论摘要截到句末（不在关键数字前截断）；事项页不露开发调试字段；复核页顶栏有主按钮", async () => {
  const { summaryClip } = await import("../src/lib/summary-clip.ts");
  const line = "本次纳入测算的请求合计514,335.00元，其中未付本金445,000.00元、按合同同日万分之五暂计的违约金69,335.00元，并按100%回收假设测算，净回收514,335.00元；材料未提供具体和解报价。";
  const out = summaryClip(line);
  assert.match(out, /净回收514,335\.00元/, out);
  assert.ok(out.endsWith("；…") || out.endsWith("…") || out === line);
  assert.equal(summaryClip("短句。"), "短句。");
  const noStop = "甲".repeat(200);
  assert.equal([...summaryClip(noStop)].length, 181);
  assert.match(src("pages/RunView.tsx"), /summaryClip\(spaceDigitsCjk\(l\)\)/);
  assert.doesNotMatch(src("components/MaterialFolderBar.tsx"), /开发调试/);
  const review = src("pages/Review.tsx");
  assert.match(review, /去签发/);
  assert.match(review, /id="review-sign"/);
});

test("第二轮 区域 2：有序列表项之间隔空行仍是同一个列表；保留原文起始编号（流式半截、被段落隔开后接着写的列表）", async () => {
  const { parseBlocks } = await import("../src/lib/markdown-blocks.ts");
  const loose = parseBlocks("法院通常按以下规则调整：\n1. **甲**：一\n\n2. **乙**：二\n\n3. 丙\n\n以上条文请核验。");
  assert.deepEqual(loose.map((b) => b.t), ["p", "ol", "p"]);
  assert.deepEqual((loose[1] as { items: string[]; start: number }).items.length, 3);
  assert.equal((loose[1] as { start: number }).start, 1);
  // 流式时只到第 2 项：仍是一个列表，编号从 1 起
  const half = parseBlocks("规则：\n1. 甲\n\n2. 乙");
  assert.deepEqual(half.map((b) => b.t), ["p", "ol"]);
  // 被段落隔开后从 3 接着写：start = 3
  const cont = parseBlocks("1. 甲\n2. 乙\n\n另外说明一句。\n\n3. 丙");
  assert.equal((cont[2] as { start: number }).start, 3);
  // “3.5 万元”不是列表项；中文“1、”是
  assert.deepEqual(parseBlocks("金额 3.5 万元").map((b) => b.t), ["p"]);
  assert.equal(parseBlocks("1、甲\n2、乙")[0]!.t, "ol");
  assert.match(src("components/Markdown.tsx"), /<ol key=\{key\} start=\{b\.start !== 1 \? b\.start : undefined\}>/);
});

test("第二轮 区域 8：运行中不能提交复核；摘要第一行给含金额的句子、数字与汉字间加空格；复核页右栏两栏改上下排、状态标签不折行", async () => {
  const { leadWithAmount, spaceDigitsCjk } = await import("../src/lib/summary-clip.ts");
  const lines = ["已完整读取本事项3份材料，无排除或无法读取的材料。已生成主文书及测算附件。", "交付成果", "全部支持并足额执行时净回收514,335.00元；全部驳回时净支出8,943.35元。"];
  const out = leadWithAmount(lines);
  assert.equal(out[0], "全部支持并足额执行时净回收514,335.00元。");
  assert.equal(out[1], lines[0]);
  assert.deepEqual(leadWithAmount(["结论：净回收 514,335.00 元。", "其他"]), ["结论：净回收 514,335.00 元。", "其他"], "第一行已有金额的不动");
  assert.deepEqual(leadWithAmount(["没有金额的一句。", "第二句。"]), ["没有金额的一句。", "第二句。"]);
  assert.equal(spaceDigitsCjk("本事项3份材料，合计514,335.00元"), "本事项 3 份材料，合计 514,335.00 元");
  const run = src("pages/RunView.tsx");
  assert.match(run, /running=\{!terminal\}/);
  assert.match(run, /<span className="muted art-submit-why">完成后可提交<\/span>/);
  assert.match(run, /return leadWithAmount\(all\)\.map\(\(l\) => summaryClip\(spaceDigitsCjk\(l\)\)\);/);
  const css = src("styles.css");
  assert.match(css, /\.claim-tone \{[^}]*white-space: nowrap;/);
  assert.match(css, /\.review-checks \.claim-cols \{ grid-template-columns: 1fr; \}/);
});

test("第三轮 区域 2：生成中发送键换成“停止”（同一位置）、Esc 也能停；停止后气泡下标“已停止”、可重新回答；光标跟在字后；新问答生成中就进入自己的会话", () => {
  const chat = src("pages/Chat.tsx");
  // 按钮切换：busy 时是停止，否则是发送
  assert.match(chat, /\{busy \? \(\s*<button className="send-stop" onClick=\{stop\} aria-label="停止生成" title="停止生成（Esc）">/);
  assert.match(chat, /\) : \(\s*<button className="send" disabled=\{!text\.trim\(\)\} onClick=\{\(\) => void send\(\)\} aria-label="发送"/);
  assert.match(chat, /if \(id\) void api\.chatStop\(id\)/);
  // Esc：只在生成中挂监听
  assert.match(chat, /if \(!busy\) return;\s*const onKey = \(e: KeyboardEvent\) => \{\s*if \(e\.key === "Escape" && !e\.isComposing\) stop\(\);/);
  assert.match(chat, /\{m\.stopped && <span className="msg-stopped">已停止<\/span>\}/);
  assert.match(chat, /\{isLast && prevQ && \(/, "最后一条（含已停止的）回答下有“重新回答”");
  assert.doesNotMatch(chat, /className="stream-caret"/, "不再单独起一行放光标");
  assert.match(chat, /msg msg-assistant\$\{pending\.draft \? " is-streaming" : ""\}/);
  assert.match(chat, /<div className="msg-meta">刚刚<\/div>/);
  assert.match(chat, /typeof m\.conversation_id === "string" && adoptedRef\.current !== sid/);
  const css = src("styles.css");
  assert.match(css, /\.is-streaming \.md > :is\(ol, ul\):last-child > li:last-child::after/);
  assert.match(src("api.ts"), /chatStop: \(streamId: string\) => invoke<\{ ok: boolean \}>\("chat\.stop", \{ stream_id: streamId \}\)/);
});
