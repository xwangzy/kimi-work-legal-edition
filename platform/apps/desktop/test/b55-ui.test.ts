/**
 * 第 55 批（界面）：方法库目录、开始面板的案情 / 逐项请求、任务说明排版、时间线折叠、事实时间线、品牌组合。
 * 行为用纯函数断言；源码断言只留“入口还在”这一类（审计 B 6.2：不再新增匹配写法的断言）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCatalog, catalogCounts, catalogLineOf, matchesQuery, unplacedCards } from "../src/lib/method-catalog.ts";
import { BRIEF_MIN_CHARS, SCENARIOS, briefFilename, briefGoalLine, buildGoal, caseGap, numbered, skillArgsOf, startPanelBrief, startPanelInitial } from "../src/lib/scenarios.ts";
import { goalPreview, goalRows } from "../src/lib/goal-brief.ts";
import { foldDoneSteps, type Step, type TimelineItem } from "../src/lib/timeline.ts";
import { sortFactsByDate } from "../src/lib/facts.ts";
import { reviewSteps } from "../src/lib/deliverables.ts";
import { deviceLine } from "../src/lib/account.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");
const card = (id: string) => SCENARIOS.find((c) => c.id === id)!;

test("方法库目录：每张卡都排进了某个阶段；各线数量之和等于总数；通用卡归“通用”", () => {
  assert.deepEqual(unplacedCards(), [], "新加的场景卡要排进 lib/method-catalog.ts 的阶段表");
  const n = catalogCounts();
  assert.equal(n.litigation + n.transactional + n.inhouse + n.general, SCENARIOS.length);
  assert.equal(n.all, SCENARIOS.length);
  const all = buildCatalog();
  assert.equal(all.reduce((s, x) => s + x.count, 0), SCENARIOS.length, "目录里一张不多、一张不少");
  const ids = all.flatMap((s) => s.groups.flatMap((g) => g.cards.map((c) => c.id)));
  assert.equal(new Set(ids).size, ids.length, "同一张卡不出现两次");
  assert.equal(catalogLineOf(card("research-lit")), "general");
  assert.equal(catalogLineOf(card("pleading")), "litigation");
  // 诉讼线第一段是接案，起诉状在“起诉与应诉”
  const lit = buildCatalog({ line: "litigation" })[0]!;
  assert.equal(lit.groups[0]!.stage, "接案与案情");
  assert.ok(lit.groups.find((g) => g.stage === "起诉与应诉")!.cards.some((c) => c.id === "pleading"));
});

test("方法库搜索：标题、交付件、材料、常用说法都能搜；多个词都要命中；搜不到返回空目录", () => {
  assert.ok(matchesQuery(card("pleading"), "起诉状"));
  assert.ok(matchesQuery(card("redraft"), "回稿"));
  assert.ok(matchesQuery(card("amount"), "利息"), "意图关键词");
  assert.ok(matchesQuery(card("pleading"), "起诉  证据目录"), "两个词都命中");
  assert.equal(matchesQuery(card("pleading"), "起诉 尽调"), false);
  assert.ok(matchesQuery(card("pleading"), "  "), "空词不筛");
  assert.deepEqual(buildCatalog({ query: "不存在的方法名字" }), []);
  const hit = buildCatalog({ query: "答辩" });
  assert.ok(hit.some((s) => s.line === "litigation") && hit.some((s) => s.line === "inhouse"), "搜索跨业务线");
  // 没列进阶段表的卡落到该线末尾的“其他”，不会丢
  const extra = { ...card("pleading"), id: "brand-new-card", title: "新方法" };
  const withExtra = buildCatalog({ line: "litigation" }, [...SCENARIOS, extra])[0]!;
  assert.equal(withExtra.groups.at(-1)!.stage, "其他");
  assert.deepEqual(withExtra.groups.at(-1)!.cards.map((c) => c.id), ["brand-new-card"]);
});

test("开始面板：起诉状收案情、逐项诉讼请求、当事人信息；请求自动编号；长文字不进方法参数", () => {
  const p = card("pleading");
  assert.ok(p.brief, "起诉状可以直接写案情");
  assert.deepEqual(p.fields.map((f) => f.key), ["claims", "court", "forum_basis", "preserve", "party_info"]);
  assert.deepEqual(p.fields.filter((f) => f.more).map((f) => f.key), ["forum_basis", "preserve", "party_info"], "不常用的收进更多选项");
  assert.equal(numbered(["判令被告支付货款 100 万元。", "  ", "诉讼费由被告承担；"]), "1. 判令被告支付货款 100 万元；2. 诉讼费由被告承担");
  assert.equal(numbered(["只有一项"]), "只有一项");
  assert.equal(numbered([""]), "");
  const goal = buildGoal(p, { claims: ["支付货款 100 万元", "承担诉讼费"], court: "杭州市余杭区人民法院", preserve: "同时申请" }, "");
  assert.equal(goal, "请起草民事起诉状。诉讼请求（按我列的顺序与取舍写）：1. 支付货款 100 万元；2. 承担诉讼费。拟受理法院：杭州市余杭区人民法院。财产保全：同时申请。");
  assert.equal(buildGoal(p, { claims: [""] }, ""), "请起草民事起诉状。", "没填的整句省略");
  // 方法参数：短字段进，逐项请求与当事人信息（goalOnly）不进
  assert.deepEqual(skillArgsOf(p, { claims: ["a", "b"], court: "某法院", forum_basis: "协议管辖", party_info: "原告：……" }), { court: "某法院", forum_basis: "协议管辖" });
});

test("开始面板：没有材料、没有事实、也没写案情时不能开始；有其一即可；事实数没读到不拦", () => {
  const p = card("pleading");
  const long = "甲公司与乙公司 2025 年 3 月签订买卖合同，乙公司欠货款 100 万元未付。";
  assert.equal(caseGap(p, { matterDocs: 0, facts: 0, brief: "" }), true);
  assert.equal(caseGap(p, { matterDocs: 0, facts: 0, brief: "见附件" }), true, `不足 ${BRIEF_MIN_CHARS} 字不算案情`);
  assert.equal(caseGap(p, { matterDocs: 0, facts: 0, brief: long }), false);
  assert.equal(caseGap(p, { matterDocs: 2, facts: 0, brief: "" }), false);
  assert.equal(caseGap(p, { matterDocs: 0, facts: 3, brief: "" }), false);
  assert.equal(caseGap(p, { matterDocs: 0, facts: null, brief: "" }), false, "读不到事实数时不拦");
  assert.equal(caseGap(card("contract-review"), { matterDocs: 0, facts: 0, brief: "" }), false, "没有案情入口的卡不走这条（它们按材料份数拦）");
  // 可以直接写案情的卡（原来有四张至少要一份材料或根本没有入口）
  for (const id of ["pleading", "arbitration-app", "demand-lit", "amount", "case-analysis", "intake-lit", "intake", "agency"]) assert.ok(card(id).brief, id);
  for (const id of ["case-analysis", "intake-lit", "intake"]) assert.equal(card(id).minMaterials, 0, `${id} 没有材料也能开始`);
});

test("开始面板：案情存成材料的文件名固定；任务说明里指向它；输入框里的长段话进案情栏、短要求仍是补充要求", () => {
  assert.equal(briefFilename("2026-11-22"), "案情说明（律师口述）2026-11-22.txt");
  const p = card("pleading");
  assert.equal(briefGoalLine(p, "  ", "2026-11-22"), "");
  assert.match(briefGoalLine(p, "案情……", "2026-11-22"), /^案情经过见材料《案情说明（律师口述）2026-11-22\.txt》：这是我对情况的陈述，先读它；其中的事实按“待我确认”处理，不列进证据目录。$/);
  assert.equal(briefGoalLine(card("contract-review"), "案情……", "2026-11-22"), "");
  const long = "帮我起草一份民事起诉状。基本事实：甲公司 2025 年 3 月向乙公司供货，乙公司收货后欠货款 100 万元，多次催告不付。";
  assert.equal(startPanelBrief(p, long), long);
  assert.deepEqual(startPanelInitial(p, long), { values: {}, extra: "" }, "进了案情栏的不再放进补充要求");
  assert.equal(startPanelBrief(p, "起草起诉状"), "");
  assert.deepEqual(startPanelInitial(p, "起草起诉状"), { values: {}, extra: "起草起诉状" });
  assert.equal(startPanelBrief(card("contract-review"), long), "", "没有案情入口的卡照旧");
  assert.equal(startPanelBrief(card("research-lit"), long), "", "有必填问题栏的卡归问题栏");
});

test("任务说明排版：拆成“标签：内容”的行，逐项请求拆开，不改字；折叠时预览第一句", () => {
  const goal = "请起草民事起诉状。诉讼请求（按我列的顺序与取舍写）：1. 支付货款 100 万元；2. 承担诉讼费。拟受理法院：杭州市余杭区人民法院。\n案情经过见材料《案情说明（律师口述）2026-11-22.txt》：这是我对情况的陈述，先读它。\n重点写违约金";
  const rows = goalRows(goal);
  assert.deepEqual(rows[0], { text: "请起草民事起诉状。" });
  assert.deepEqual(rows[1], { label: "诉讼请求", text: "", items: ["支付货款 100 万元", "承担诉讼费"] });
  assert.deepEqual(rows[2], { label: "拟受理法院", text: "杭州市余杭区人民法院" });
  assert.equal(rows.at(-1)!.text, "重点写违约金");
  assert.equal(goalPreview(goal), "请起草民事起诉状");
  assert.equal([...goalPreview("很长".repeat(40), 10)].length, 11, "过长截断加省略号");
  // 正文里带冒号的长句不误拆成标签
  assert.deepEqual(goalRows("我确认过的事实照写，材料载明但未确认的正文用附条件写法：列进核对清单。"), [{ text: "我确认过的事实照写，材料载明但未确认的正文用附条件写法：列进核对清单。" }]);
});

test("时间线：一长串做完的步骤折成一行；失败、等待、联网步骤不折；短的不折", () => {
  const st = (key: string, icon: Step["icon"] = "ok", title = "读取材料"): TimelineItem => ({ kind: "step", step: { key, title, icon, at: "2026-11-22T00:00:00Z", level: "key" } as Step });
  const ids = (xs: ReturnType<typeof foldDoneSteps>) => xs.map((x) => (x.kind === "fold" ? `fold(${x.items.length})` : x.kind === "step" ? x.step.key : "sub"));
  const many = ["a", "b", "c", "d", "e", "f", "g"].map((k) => st(k));
  assert.deepEqual(ids(foldDoneSteps([...many, st("w", "wait")])), ["a", "fold(4)", "f", "g", "w"]);
  assert.deepEqual(ids(foldDoneSteps(many.slice(0, 6))), ["a", "b", "c", "d", "e", "f"], "中间不足四步不折（只折两三步省不了地方）");
  // 失败步骤把一段切开：前后各自判断
  assert.deepEqual(ids(foldDoneSteps([...many.slice(0, 3), st("x", "fail"), ...many.slice(3)])), ["a", "b", "c", "x", "d", "e", "f", "g"]);
  // 联网步骤不进折叠（律师要能直接看到实际发出了什么）
  const net = foldDoneSteps([st("a"), st("b"), st("n", "ok", "联网查资料"), st("c"), st("d")]);
  assert.ok(ids(net).includes("n"));
});

test("事实时间线：按日期排，日期不明的在最后，同一天按序号；不改原数组", () => {
  const facts = [
    { occurred_on: "2025-06-20", no: 3 },
    { occurred_on: null, no: 9 },
    { occurred_on: "2025-03-10", no: 4 },
    { occurred_on: "2025-06-20", no: 1 },
    { occurred_on: "2025-03", no: 7 },
  ];
  assert.deepEqual(sortFactsByDate(facts).map((f) => f.no), [7, 4, 1, 3, 9]);
  assert.equal(facts[0]!.no, 3);
});

test("入口还在：方法库页挂本所范本；开始面板任何时候都有上传入口并能存案情；品牌用字标 + 小标", () => {
  const m = src("pages/Methods.tsx");
  assert.match(m, /<FirmTemplates \/>/);
  assert.match(m, /buildCatalog\(/);
  const ss = src("components/ScenarioStart.tsx");
  assert.match(ss, /className=\{`ss-drop/);
  assert.match(ss, /api\.importMaterialText\(matter\.matter_id, briefFilename\(day\), text\)/);
  assert.doesNotMatch(ss, /card\.minMaterials > 0 \|\| documents\.length > 0\) \? \(/, "上传入口不再只在已有材料或强制材料时才显示");
  const brand = src("components/Brand.tsx");
  assert.match(brand, /export function EditionTag/);
  assert.match(brand, /fontWeight="800"/, "字标是图形（样式表里不出现 700 以上的字重）");
});

test("签发页进度：草稿 → 待复核 → 已签发；退回单列；已签发是终点；未知状态全部未到", () => {
  const st = (s: string) => reviewSteps(s).map((x) => `${x.label}:${x.state}`);
  assert.deepEqual(st("draft"), ["草稿:now", "待复核:todo", "已签发:todo"]);
  assert.deepEqual(st("pending_review"), ["草稿:done", "待复核:now", "已签发:todo"]);
  assert.deepEqual(st("approved"), ["草稿:done", "待复核:done", "已签发:done"]);
  assert.deepEqual(st("rejected"), ["草稿:done", "已退回:now", "已签发:todo"]);
  assert.deepEqual(st("superseded"), ["草稿:todo", "待复核:todo", "已签发:todo"]);
});

test("第二轮入口还在：事项列表是列表行；概览的最近 AI 记录分三段；材料工具栏并成一行；设置页签带限宽类名", () => {
  const m = src("pages/Matters.tsx");
  assert.match(m, /className="mt-row"/);
  assert.doesNotMatch(m, /<table className="data matters-table">/);
  const b = src("pages/Boards.tsx");
  assert.match(b, /className="w-run-name">\{runName\(r, 20\)\}</);
  assert.match(b, /export function runTone/);
  const mt = src("pages/Matter.tsx");
  assert.match(mt, /<div className="mat-toolbar">/);
  assert.equal(mt.split("<MaterialFolderBar").length - 1, 1, "案卷文件夹只渲染一处");
  assert.match(src("pages/Connections.tsx"), /main-wide set-page set-\$\{tab\}/);
  assert.match(src("pages/Review.tsx"), /reviewSteps\(data\.status\)/);
});

test("我的电脑一行（连真实控制面复评发现）：不显示占位版本 legacy；“最近使用”不早于登记日（服务器按 UTC 记日）", () => {
  const NOW = Date.parse("2026-11-22T04:00:00.000Z");
  // 北京时间 11 月 22 日 03:04 登记；服务器把当天记成 UTC 的 11 月 21 日
  const d = deviceLine({ device_id: "dev_firm_li", registered_at: "2026-11-21T19:04:00.000Z", client_version: "legacy", last_seen_on: "2026-11-21", current: true, session: "active" }, NOW);
  assert.equal(d.meta, "11 月 22 日登记 · 最近使用 11 月 22 日");
  // 正常情形不变：最近使用晚于登记日照原样显示，真实版本号照常显示
  const e = deviceLine({ device_id: "dev_firm_li", registered_at: "2026-11-01T02:00:00.000Z", client_version: "0.2.0", last_seen_on: "2026-11-14", current: true, session: "active" }, NOW);
  assert.equal(e.meta, "11 月 1 日登记 · 最近使用 11 月 14 日 · 版本 0.2.0");
});

test("第三轮入口还在：账号页“本所”一行名称与姓名同一个 span；起草律所策略一行一项；操作记录时间列不再靠右", () => {
  const c = src("pages/Connections.tsx");
  assert.match(c, /<span>\s*<b>\{firm\.firm\?\.name\}<\/b>/);
  assert.match(c, /className="settings-grid pd-grid"/);
  for (const t of ["敏感事项可以用通用 AI 服务（强制全部化名）", "律师可以把问题报告直接发给客服", "同事之间可以经中软同步团队事项（加密，中软打不开）", "放宽的规则须管理员各自在电脑上确认后才生效（团队版 1 人，律所版 2 人）。"]) assert.ok(c.includes(t), t);
  assert.match(src("pages/FirmUsage.tsx"), /<td className="nowrap audit-at">\{fmtTime\(r\.at\)\}<\/td>/);
});

test("第四轮：不可逆期限的起算日必填；每张卡直接显示的字段不超过 6 个，其余在“更多选项”", () => {
  const req = (id: string, key: string) => card(id).fields.find((f) => f.key === key)?.required === true;
  assert.ok(req("defense", "received_on"), "答辩期、管辖权异议的期限从收到起诉状副本之日起算");
  assert.ok(req("appeal", "served_on"), "上诉期从送达之日起算");
  assert.ok(req("enforcement", "due_on"), "申请执行的期间从履行期限最后一日起算");
  assert.ok(req("labor-response", "received_on"), "劳动仲裁答辩期从收到申请书副本之日起算");
  for (const c of SCENARIOS) assert.ok(c.fields.filter((f) => !f.more).length <= 6, `${c.id} 直接显示的字段太多：${c.fields.filter((f) => !f.more).map((f) => f.label).join("、")}`);
  // 任务说明模板里的每个 {键} 都有对应字段（补字段时漏改模板或写错键会在这里报）
  for (const c of SCENARIOS) for (const m of c.goal.matchAll(/\{(\w+)\}/g)) assert.ok(c.fields.some((f) => f.key === m[1]), `${c.id} 的任务说明用了 {${m[1]}}，卡上没有这个字段`);
  // 反过来：卡上的每个字段都进了任务说明（没有收了不用的）
  for (const c of SCENARIOS) for (const f of c.fields) assert.ok(c.goal.includes(`{${f.key}}`) || c.scenario !== "a1.agent_task", `${c.id} 收了「${f.label}」却没写进任务说明`);
});

test("第四轮：任务说明里一句话末尾的几项没填时，句子仍以句号结束；填了的照常用分号连着", () => {
  const pr = card("procedure");
  assert.equal(buildGoal(pr, { claims: "支付货款 120 万元", side: "拟起诉" }, ""), "请核查管辖与诉讼时效：拟主张的请求为支付货款 120 万元；我方：拟起诉。");
  assert.equal(buildGoal(pr, { claims: "支付货款 120 万元", side: "拟起诉", amount: "120 万元" }, ""), "请核查管辖与诉讼时效：拟主张的请求为支付货款 120 万元；我方：拟起诉；标的额：120 万元。");
  assert.equal(buildGoal(pr, { claims: "支付货款 120 万元", side: "已被诉", received_on: "2026-11-18" }, ""), "请核查管辖与诉讼时效：拟主张的请求为支付货款 120 万元；我方：已被诉；收到诉状或仲裁申请书的日期：2026-11-18。");
});

test("第四轮：劳动仲裁申请书收劳动关系要素与逐项请求；答辩状的程序抗辩是多选；函件两张卡共用发函名义", () => {
  const la = card("labor-arb-application");
  assert.deepEqual(la.fields.map((f) => f.key), ["side", "claims", "hired_on", "left_on", "leave_type", "monthly_wage"]);
  assert.equal(
    buildGoal(la, { side: "劳动者", claims: ["支付违法解除劳动合同赔偿金", "支付未休年休假工资"], hired_on: "2021-03-01", left_on: "2026-10-31", leave_type: "被辞退", monthly_wage: "12,000 元" }, ""),
    "请起草劳动仲裁申请书：我方为劳动者；拟主张的请求：1. 支付违法解除劳动合同赔偿金；2. 支付未休年休假工资。入职日期：2021-03-01；离职日期：2026-10-31；离职方式：被辞退；月工资：12,000 元。",
  );
  assert.deepEqual(skillArgsOf(la, { side: "劳动者", claims: ["a"], hired_on: "2021-03-01", monthly_wage: "12,000 元" }), { doc_kind: "申请书", side: "劳动者", hired_on: "2021-03-01", monthly_wage: "12,000 元" });
  const d = card("defense");
  assert.equal(d.fields.find((f) => f.key === "procedural")!.kind, "multi");
  assert.match(buildGoal(d, { received_on: "2026-11-18", stance: "部分认可", procedural: ["管辖权异议", "反诉"] }, ""), /总体意见：部分认可。拟提的程序抗辩与反诉：管辖权异议、反诉。/);
  assert.equal(card("demand-lit").fields.find((f) => f.key === "sender"), card("demand-inhouse").fields.find((f) => f.key === "sender"));
});
