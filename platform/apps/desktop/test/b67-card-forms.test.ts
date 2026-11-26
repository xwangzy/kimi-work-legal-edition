/**
 * 第 67 批（V41 工作线 B、G、C、F）：开始面板按业务形态排段、右栏取消后的页脚去向一行、首页“+”菜单、用量页单一焦点、登录注册同一骨架。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCENARIOS as SCENARIO_CARDS } from "../src/lib/scenarios.ts";
import { cardForm, compareSlots, extraPlaceholder, materialsHint, provisionalSendLine, sectionOrder, sectionTitle, selectDefaultPlaceholder, sendLine } from "../src/lib/card-layout.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");
const byId = (id: string) => SCENARIO_CARDS.find((c) => c.id === id)!;

test("52 张卡都有形态；要写当事人首部的一律是起草形态；比对、整理、审查、研究各有代表卡", () => {
  assert.equal(SCENARIO_CARDS.length, 52);
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
  assert.match(s, /provisionalSendLine\(matter\)/, "第二轮：估算到之前去向一行也在");
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

test("套餐与用量：一个焦点（本期已用 %）、剩余 = 1 − 已用、按模型并进图例、5 小时一行；不出现点数、金额与购买按钮", () => {
  const s = src("pages/PersonalUsage.tsx");
  assert.match(s, /const remaining = v\.available;/, "第二轮：可用 = 1 − 已用 − 预留，三项加起来 100%");
  assert.match(s, /元额度（按价目计）/, "套餐说明里的金额被去掉（正则在源码里）");
  assert.doesNotMatch(s, /<th className="num">处理量<\/th>/, "处理量（原始计数）不再作为一列给律师看");
  assert.match(s, /className=\{`pu-big-v tone-\$\{tone\}`\}/);
  assert.match(s, /<ul className="pu-models2" aria-label="按模型">/);
  assert.match(s, /className="pu-burst2"/);
  const code = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /点数|积分|购买<\/button>|¥/);
});

test("登录与注册同一骨架：注册不再有标题下两行说明；同一级标题；“已有账号？登录”与“还没有账号？注册”都在表单下方同一行；卡片从同一高度起排", () => {
  const a = src("pages/Activate.tsx");
  const reg = a.slice(a.indexOf("function RegisterForm"), a.indexOf("function ForgotPassword"));
  assert.match(reg, /className="auth-form quiet"/);
  assert.match(reg, /<h1 className="auth-method-single">注册账号<\/h1>/);
  assert.doesNotMatch(reg, /activate-lead/);
  assert.match(reg, /<div className="auth-links">\s*<span>\s*已有账号？/);
  assert.match(src("styles-auth.css"), /\.auth-page \{ place-items: start center; padding-top: max\(40px, calc\(50vh - 360px\)\); \}/);
});

test("第四轮：立场与文书方向对不上时只提醒不拦（答辩状挂在原告事项上）", async () => {
  const { stanceMismatchText } = await import("../src/lib/card-layout.ts");
  assert.match(stanceMismatchText("defense", "plaintiff")!, /我方是原告/);
  assert.equal(stanceMismatchText("defense", "defendant"), null);
  assert.match(stanceMismatchText("pleading", "defendant")!, /我方是被告/);
  assert.equal(stanceMismatchText("contract-review", "plaintiff"), null);
  assert.match(src("components/ScenarioStart.tsx"), /stanceMismatchText\(card\.id, matter\.stance\)/);
});
