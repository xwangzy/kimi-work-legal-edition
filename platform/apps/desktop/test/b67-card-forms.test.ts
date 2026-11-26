/**
 * 第 67 批（V41 工作线 B、G、C、F）：开始面板按业务形态排段、右栏取消后的页脚去向一行、首页“+”菜单、用量页单一焦点、登录注册同一骨架。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCENARIOS as SCENARIO_CARDS } from "../src/lib/scenarios.ts";
import { cardForm, compareSlots, extraPlaceholder, isCalcCard, materialsHint, provisionalSendLine, sectionOrder, sectionTitle, selectDefaultPlaceholder, sendLine } from "../src/lib/card-layout.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");
const byId = (id: string) => SCENARIO_CARDS.find((c) => c.id === id)!;

test("53 张卡都有形态（第 65 批加了诉讼成本卡）；要写当事人首部的一律是起草形态；比对、整理、审查、研究各有代表卡", () => {
  assert.equal(SCENARIO_CARDS.length, 53);
  for (const c of SCENARIO_CARDS) {
    const f = cardForm(c);
    assert.ok(["draft", "review", "compare", "analyze", "organize"].includes(f), c.id);
    if (c.needsParties) assert.equal(f, "draft", `${c.id} 写当事人首部`);
    if (c.scenario === "s1b.draft_compare" || c.skill === "redraft-review") assert.equal(f, "compare", c.id);
  }
  const expect: Record<string, string> = {
    pleading: "draft",
    defense: "draft",
    "contract-draft": "draft",
    "hearing-outline": "draft",
    "contract-review": "review",
    "contract-review-inhouse": "review",
    privacy: "review",
    "suit-received": "review",
    "labor-response": "review",
    redraft: "compare",
    "redraft-local": "compare",
    casefile: "organize",
    "casefile-deep": "organize",
    "audience-pack": "organize",
    intake: "organize",
    "research-deal": "analyze",
    "compliance-qa": "analyze",
    amount: "analyze",
    "litigation-budget": "analyze",
    issues: "analyze",
    "labor-termination": "analyze",
  };
  for (const [id, f] of Object.entries(expect)) assert.equal(cardForm(byId(id)), f, id);
  // 每种形态至少 3 张卡（不是只为一两张卡做的特例）
  const n = (f: string) => SCENARIO_CARDS.filter((c) => cardForm(c) === f).length;
  for (const f of ["draft", "review", "analyze", "organize"]) assert.ok(n(f) >= 3, `${f}：${n(f)} 张`);
  assert.equal(n("compare"), 2);
});

test("段序：起草先定要点再当事人、材料在后；研究先写问题；审查 / 比对 / 整理先给文件", () => {
  assert.deepEqual(sectionOrder("draft"), ["decide", "parties", "materials"]);
  assert.deepEqual(sectionOrder("analyze"), ["decide", "materials", "parties"]);
  for (const f of ["review", "compare", "organize"] as const) assert.equal(sectionOrder(f)[0], "materials", f);
  // 段名随形态
  const o = { hasBrief: false, hasDecide: true };
  assert.equal(sectionTitle("review", "materials", o), "要审的文件");
  assert.equal(sectionTitle("compare", "materials", o), "两稿");
  assert.equal(sectionTitle("organize", "materials", o), "案卷材料");
  assert.equal(sectionTitle("draft", "decide", o), "文书要点");
  assert.equal(sectionTitle("review", "decide", o), "审查重点", "立场取自事项（事项一行写着“我方”）");
  assert.equal(sectionTitle("review", "decide", { ...o, hasSide: true }), "立场与重点");
  assert.equal(sectionTitle("analyze", "decide", { ...o, hasQuestion: true }), "要回答的问题");
  assert.equal(sectionTitle("analyze", "decide", o), "分析要点");
  assert.equal(sectionTitle("draft", "materials", { hasBrief: true, hasDecide: true }), "案情与材料", "可以直接写案情的卡");
  assert.equal(sectionTitle("compare", "decide", { hasBrief: false, hasDecide: false }), "补充要求", "没有字段时只有补充要求");
  assert.deepEqual(compareSlots(byId("redraft")), ["上一稿", "回稿"]);
  // 第二轮：研究类材料段只说材料；补充要求示例按形态；下拉缺省写进占位
  assert.equal(materialsHint(byId("research-deal"), "analyze"), "可附交易文件，不附也能开始");
  assert.equal(materialsHint(byId("compliance-qa"), "analyze"), "可附业务材料，不附也能开始");
  assert.equal(materialsHint(byId("legal-opinion"), "analyze"), "相关合同、章程、函件等材料");
  assert.equal(materialsHint(byId("contract-review"), "review"), byId("contract-review").gives);
  const ph = new Set(SCENARIO_CARDS.map((c) => extraPlaceholder(cardForm(c), c.scenario === "a1.agent_task")));
  assert.ok(ph.size >= 5, "补充要求示例不再全是同一句");
  assert.ok(![...ph].includes("例如：重点看交割前提条件"));
  assert.equal(selectDefaultPlaceholder("不选按“我方测算”"), "我方测算（缺省）");
  assert.equal(selectDefaultPlaceholder("不选按合同约定，找不到会先问你"), "合同约定（缺省）");
  assert.equal(selectDefaultPlaceholder("还在职的不填"), undefined);
  assert.deepEqual(compareSlots(byId("redraft-local")), ["基线稿", "对方回稿"]);
});

test("页脚去向一行：只说发给谁 + 哪些先换成代号（到“等”为止）；本机完成、不会发送如实写；完整要点在“详情”", () => {
  const bullets = ["发给 Kimi AI（经中软转发）：3 份材料里用到的内容", "姓名、证件号、账号、电话先换成代号", "公司名、案情、金额、日期、条款按原文；没认出的姓名也按原文", "联网检索先去掉当事人名称；要带名称查时逐条问你", "服务方是否保存，以其企业协议为准；每次发送都有记录"];
  const kinds = ["route", "protect", "plain", "search", "keep"];
  assert.deepEqual(sendLine(bullets, kinds), { text: "发给 Kimi AI（经中软） · 姓名等先换成代号", tone: "normal" });
  assert.equal(sendLine(["发给律所自己的 Kimi 账号（不经中软）：任务说明和用到的材料", "姓名、公司名、证件号、账号先换成代号"], ["route", "protect"])!.text, "发给本所 Kimi 账号（不经中软） · 姓名、公司名等先换成代号");
  assert.deepEqual(sendLine(["全部在这台电脑上完成，不发送任何内容"], ["local"]), { text: "全部在这台电脑上完成，不发送任何内容", tone: "local" });
  assert.deepEqual(sendLine(["不会发送：这个事项已结案"], ["blocked"]), { text: "不会发送：这个事项已结案", tone: "blocked" });
  assert.equal(sendLine(undefined, undefined), null);
  // 估算到之前按事项设置写（与内核同一口径）
  assert.equal(provisionalSendLine({ model_endpoint: "standard", data_level: "L2" }), "发给 Kimi AI（经中软） · 姓名等先换成代号");
  assert.equal(provisionalSendLine({ model_endpoint: "byok", data_level: "L3a" }), "发给本所 Kimi 账号（不经中软） · 姓名、公司名等先换成代号");
  assert.equal(provisionalSendLine({ model_endpoint: "none" }), "全部在这台电脑上完成，不发送任何内容");
  assert.equal(provisionalSendLine(null), null);
  // 开始面板：右栏取消；详情弹层里仍是同一块 SendPoints + 疑似姓名核对 + 用量；“怎么做”在标题栏
  const s = src("components/ScenarioStart.tsx");
  assert.doesNotMatch(s, /className="ss-aside"/);
  assert.match(s, /<SendPoints dataWhere=\{estimate\.estimate\.data_where\}>[\s\S]{0,200}<SendSummary/);
  assert.match(s, /mustReview=\{dw\.block_kind === "suspects"\}/, "敏感事项疑似姓名仍须核对");
  assert.match(s, /另有 \$\{suspects\} 处像姓名的文字没换成代号/, "没换成代号的疑似姓名直接写在页脚");
  assert.match(s, /headExtra=\{<HowItWorks/);
  assert.match(s, /结果都是草稿，需要你复核后使用。/, "草稿须复核的告知仍在（怎么做弹层）");
  assert.match(s, /<span className="ss-foot-draft">结果是草稿，须你复核后使用<\/span>/, "第二轮：开工按钮旁常驻");
  assert.match(s, /provisionalSendLine\(matter, consentFirst\(matter\)\)/, "第二轮：估算到之前去向一行也在（第 69 批：首次用 AI 时后接“先记录客户授权”，估算前后同一句）");
  // 弹层的 Esc 不把开始面板一起关掉
  assert.match(s, /document\.addEventListener\("keydown", esc, true\)/);
  assert.match(src("components/Modal.tsx"), /headExtra\?: ReactNode/);
});

test("首页上传：一个材料面板两种进入——“+”打开面板并直接选择文件（进度与结果在面板里），“@ 材料”选读哪些；面板整块接拖放、标题栏上传、底栏隐私说明", () => {
  const c = src("components/Composer.tsx");
  assert.doesNotMatch(c, /className="popover add-pop"/, "第四轮：不再有与“@ 材料”重复的“+”小菜单");
  assert.match(c, /setMenu\("material"\);\s*\/\/[^\n]*\n\s*if \(props\.matterId && props\.importOne\) setTimeout\(\(\) => pickInPop\.current\?\.\(\), 60\);/);
  assert.match(c, /dropZone="root"\s*openRef=\{pickInPop\}/);
  assert.match(c, /<Icon\.upload \/> 上传文件/);
  assert.match(c, /原件只读；发给 AI 前，姓名、证件号等先换成代号/);
  const mp = src("components/MaterialPicker.tsx");
  assert.match(mp, /dropZone\?: "box" \| "root";/);
  assert.match(mp, /松手即存入「\{p\.matterTitle\}」/);
});

// 第 68 批：套餐与用量重构（只给本人、大数字 + 一根条 + 重置、5 小时一行、按日分组明细、套餐设置行），守护用例移到 b68-personal-usage.test.ts；
// 这里保留第 67 批立下的底线：不出现点数、金额与购买按钮，套餐说明里的金额去掉，处理量（原始计数）不作为一列。
test("套餐与用量（底线）：不出现点数、金额与购买按钮；套餐说明去金额；处理量不作为一列", () => {
  const s = src("pages/PersonalUsage.tsx");
  assert.match(s, /planNoteText\(plan\?\.note\)/, "套餐说明经 planNoteText 去掉金额");
  assert.doesNotMatch(s, /<th[^>]*>处理量<\/th>/, "处理量（原始计数）不再作为一列给律师看");
  const code = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /点数|积分|购买<\/button>|¥|元/);
});

test("登录与注册同一骨架（第 69 批：注册分两步，每步至多三个输入）：同一级标题；“已有账号？登录”与“还没有账号？注册”都在表单下方同一行；卡片从同一高度起排", () => {
  const a = src("pages/Activate.tsx");
  const reg = a.slice(a.indexOf("function RegisterForm"), a.indexOf("function ForgotPassword"));
  assert.match(reg, /className="auth-form quiet"/);
  assert.match(reg, /<h1 className="auth-title">注册<\/h1>/);
  assert.match(reg, /<h1 className="auth-title">设置账号<\/h1>/);
  assert.doesNotMatch(reg, /activate-lead|auth-check-note|不勾选即自助注册/);
  assert.match(reg, /<div className="auth-links">\s*<span>\s*已有账号？/, "第①步表单下方：已有账号？登录");
  const css = src("styles-auth.css");
  assert.match(css, /\.auth-page \{[^}]*place-items: start center; padding: max\(40px, calc\(50vh - 330px\)\)/);
  // 第二轮（独立评审 R1-3）：卡片整体同一最小高度、页脚固定在卡底
  // 第三轮：最小高度 520——短状态（登录、注册两步、找回、换账号）同高且不留大块空白；电脑数已满（列表）按内容长高
  assert.match(css, /\.auth-card \{ display: flex; flex-direction: column; min-height: 520px; box-sizing: border-box; width: min\(420px, 100%\);/);
  assert.match(css, /\.auth-card-body \{ display: flex; flex: 1 1 auto;/);
});

test("第四轮：立场与文书方向对不上时只提醒不拦（答辩状挂在原告事项上）", async () => {
  const { stanceMismatchText } = await import("../src/lib/card-layout.ts");
  assert.match(stanceMismatchText("defense", "plaintiff")!, /我方是原告/);
  assert.equal(stanceMismatchText("defense", "defendant"), null);
  assert.match(stanceMismatchText("pleading", "defendant")!, /我方是被告/);
  assert.equal(stanceMismatchText("contract-review", "plaintiff"), null);
  assert.match(src("components/ScenarioStart.tsx"), /stanceMismatchText\(card\.id, matter\.stance\)/);
});

// 第 69 批（V43，融合审查 F-01）：第 65 批新卡落到起草形态、借用原告口吻示例而用例全过——守卫：每张用 AI 的卡都要有自己的“补充要求”示例，
// 示例不得在别的卡上重复出现（个别同类卡共用一句的列入白名单）；测算卡的“要定的一段”叫测算口径
test("第 53 张卡（诉讼成本与回收测算）按测算类排段；每张 AI 卡都有自己的补充要求示例", () => {
  const c = byId("litigation-budget");
  assert.equal(cardForm(c), "analyze");
  assert.ok(isCalcCard(c) && isCalcCard(byId("amount")) && !isCalcCard(byId("pleading")));
  assert.equal(sectionTitle("analyze", "decide", { hasBrief: true, hasDecide: true, calc: true }), "测算口径");
  assert.equal(sectionTitle("analyze", "materials", { hasBrief: true, hasDecide: true }), "案情与材料");
  const own = extraPlaceholder(cardForm(c), true, c.id);
  assert.match(own, /律师费|和解/);
  assert.doesNotMatch(own, /原告|被告|对方逾期/, "不带一方立场的口吻");
  const formDefaults = new Set((["draft", "review", "compare", "analyze", "organize"] as const).map((f) => extraPlaceholder(f, true)));
  for (const x of SCENARIO_CARDS.filter((x) => x.scenario === "a1.agent_task")) {
    const ph = extraPlaceholder(cardForm(x), true, x.id);
    assert.ok(!formDefaults.has(ph) || ["pleading", "contract-review", "redraft"].includes(x.id), `${x.id} 没有自己的补充要求示例（借用了形态缺省“${ph}”）`);
  }
});

test("第 69 批第五轮：首次在事项上用 AI——底栏去向照写并接“先记录客户授权”，估算前后同一句；主按钮仍是卡的动作（加“…”）", async () => {
  const { provisionalSendLine, consentFirst, sendLine } = await import("../src/lib/card-layout.ts");
  const m = { model_endpoint: "standard", data_level: "L2", full_pseudonym: false, basis_state: "pending" };
  assert.equal(consentFirst(m), true);
  assert.equal(consentFirst({ ...m, basis_state: "valid" }), false);
  assert.equal(consentFirst({ ...m, model_endpoint: "none" }), false);
  const line = provisionalSendLine(m, consentFirst(m));
  assert.equal(line, "发给 Kimi AI（经中软） · 姓名等先换成代号 · 先记录客户授权");
  // 估算回来（block_kind = consent）仍是同一句、不是红字
  assert.deepEqual(sendLine(["四项依据有“待确认”（……）"], ["blocked"], "consent", line), { text: line, tone: "normal" });
  assert.match(src("components/ScenarioStart.tsx"), /\(matter && consentFirst\(matter\)\) \? `\$\{card\.verb\}…` : card\.verb/);
});
