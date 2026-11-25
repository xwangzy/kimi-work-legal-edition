/**
 * 第 66 批（V40）界面重构的守护用例：论点确认卡的“需要你判断”与汇总、依据徽标、个人用量口径、模型选项、菜单用量行、
 * 设置页统一版心、首页去页脚与 @材料直传、拖放不重复导入、开始面板两栏与必填前置。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attentionDigest, basisBadge, emptyDraft, outlineAttention, type OutlineView } from "../src/lib/outline.ts";
import { personalView } from "../src/lib/personal-usage.ts";
import { modelChoices, modelLabelOf } from "../src/lib/model-choices.ts";
import { personalUsedRatio, quotaMenuLine } from "../src/lib/quota-notice.ts";
import type { QuotaStatus } from "../src/api.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");

const outline: OutlineView = {
  outline_id: "o1",
  run_id: "r1",
  doc_kind: "民事起诉状",
  title: null,
  status: "proposed",
  decisions: null,
  lawyer_note: null,
  items: [
    {
      arg_id: "a1",
      claim: "被告应支付货款",
      counter: null,
      facts: [{ fact_id: "f1", statement: "双方签订合同", confirmed: false }],
      basis: [
        {
          law: "中华人民共和国民法典",
          matched: "中华人民共和国民法典",
          article: 626,
          note: "支付价款",
          check: "version_verified",
          article_text: "买受人应当按照约定的数额和支付方式支付价款。",
          demo: false,
          elements: [
            { element: "存在有效合同", status: "to_prove", facts: [] },
            { element: "已到期", status: "to_prove", facts: [] },
            { element: "尚欠价款", status: "fact", facts: [{ fact_id: "f2", statement: "欠 31 万", confirmed: false }] },
          ],
        },
        { law: "某地方条例", matched: null, article: 3, note: null, check: "intercepted", article_text: null, demo: false },
      ],
    },
    { arg_id: "a2", claim: "支付违约金", counter: null, facts: [{ fact_id: "f1", statement: "双方签订合同", confirmed: false }], basis: [{ law: "民法典", matched: "中华人民共和国民法典", article: 585, note: null, check: "source_verified", article_text: "x", demo: false, mode: "analogy" }] },
  ],
};

test("依据徽标：核过的短标 + 原口径完整说法；未收录与核对未通过是风险", () => {
  assert.deepEqual([basisBadge({ check: "version_verified", article_text: "x", demo: false }).label, basisBadge({ check: "version_verified", article_text: "x", demo: false }).tone], ["版本已核", "ok"]);
  assert.match(basisBadge({ check: "version_verified", article_text: "x", demo: false }).detail, /是否撑得住论点由你判断/);
  assert.equal(basisBadge({ check: "intercepted", article_text: null, demo: false, matched: null }).label, "法规库未收录");
  assert.equal(basisBadge({ check: "intercepted", article_text: null, demo: false, matched: "x" }).tone, "risk");
  assert.equal(basisBadge({ check: "unchecked", article_text: null, demo: false }).label, "未核实");
});

test("需要你判断：逐条找出依据问题、类推、待证要件与未确认事实；同一事实只报一次；去掉的论点不算", () => {
  const all = outlineAttention(outline, emptyDraft());
  assert.equal(all.filter((a) => a.kind === "basis").length, 1);
  assert.equal(all.filter((a) => a.kind === "analogy").length, 1);
  assert.equal(all.filter((a) => a.kind === "to_prove").length, 2);
  // f1 挂在两条论点上只报一次；f2 在要件里
  assert.equal(all.filter((a) => a.kind === "fact").length, 2);
  const dropped = outlineAttention(outline, { ...emptyDraft(), drop: { a2: true } });
  assert.equal(dropped.filter((a) => a.kind === "analogy").length, 0);
  const noBasis = outlineAttention(outline, { ...emptyDraft(), dropBasis: { a1: [1] } });
  assert.equal(noBasis.filter((a) => a.kind === "basis").length, 0, "去掉的依据不再要你判断");
});

test("汇总（真实走查：一张起诉状卡 31 处）：依据问题与类推逐条在前，待证要件按论点合一行，事实合成一行", () => {
  const d = attentionDigest(outlineAttention(outline, emptyDraft()));
  assert.deepEqual(d.map((x) => x.kind), ["basis", "analogy", "to_prove", "fact"]);
  assert.match(d[2]!.text, /^2 个要件待证/);
  assert.match(d[3]!.text, /^2 条事实未经你确认（底部可一并确认）$/);
  const card = src("components/OutlineConfirm.tsx");
  assert.match(card, /digest\.slice\(0, 8\)/);
  assert.match(card, /确认并开始起草（\{kept\} 条论点）/, "评测驱动按这个按钮前缀点（eval/driver.js、e2e ui.mjs）");
  assert.match(card, /签发时须写明不确认的理由/);
});

const q = (over: Partial<QuotaStatus>): QuotaStatus => ({ mode: "control_plane", firm: { used_ratio: 0.06, remaining_ratio: 0.94, in_flight_ratio: 0.19, paused: null, cap_pct: null, boost_pct: 0, legacy_used_ratio: null, used: null, total: null, seats: 1 }, ...over }) as QuotaStatus;

test("个人用量口径（独立复评：一个分母）：已用 + 进行中预留 + 可用 = 本期额度；5 小时一栏折到窗口自己的分母；菜单与页面同一个数", async () => {
  const { burstView } = await import("../src/lib/personal-usage.ts");
  const v = personalView(q({ personal: { used_ratio: 0.0597, remaining_ratio: 0.2481, limited_by: "burst", paused: null } }));
  assert.equal(v.used, 0.0597);
  assert.equal(v.inFlight, 0.19);
  assert.ok(Math.abs(v.used + v.inFlight + v.available - 1) < 1e-9, "三段加起来是整条进度条");
  assert.equal(v.now, 0.2481);
  const w = burstView({ pct: 50, used_ratio: 0.1194 }, v);
  assert.ok(Math.abs(w.inFlight - 0.38) < 1e-9, "预留折到窗口：0.19 / 0.5");
  assert.ok(Math.abs(w.available - 0.4962) < 1e-9, "此刻可用折到窗口：0.2481 / 0.5");
  // 旧云端没有 personal：单人工作室的本期额度就是本人套餐
  assert.equal(personalView(q({})).used, 0.06);
  assert.equal(personalUsedRatio(q({ own: { used_ratio: 0.3, denominator: "account_limit", enforced: true, used: 0, total: 0, requests: 1, tokens: 1, value_cny: null, estimated_rows: 0 } })), 0.3);
  assert.equal(quotaMenuLine(q({})), "已用 6%");
  assert.equal(quotaMenuLine(q({ personal: { used_ratio: 0.134, remaining_ratio: 0.5, limited_by: null, paused: null } })), "已用 13%", "菜单与用量页同取 personal");
  const page = src("pages/PersonalUsage.tsx");
  assert.doesNotMatch(page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""), /本所/, "个人页（去掉注释后）不出现“本所”");
  assert.match(page, /id="sec-usage"/);
});

test("模型选项：不可用的照样列出并带原因；缺省标注；显示名取当前所选，失效时回到缺省", () => {
  const v = {
    default: "legal/k3",
    selected: "legal/k3-fast",
    models: [
      { id: "legal/k3", label: "K3", description: "适合复杂问题", available: true, reason_text: null },
      { id: "legal/k3-fast", label: "K3 高速", description: null, available: true, reason_text: null },
      { id: "legal/x", label: "X", description: null, available: false, reason_text: "当前套餐不含这个模型" },
    ],
  } as never;
  const c = modelChoices(v);
  assert.deepEqual(c.map((x) => [x.id, x.isDefault, x.available]), [["legal/k3", true, true], ["legal/k3-fast", false, true], ["legal/x", false, false]]);
  assert.equal(c[2]!.reasonText, "当前套餐不含这个模型");
  assert.equal(modelLabelOf(v), "K3 高速");
  assert.equal(modelLabelOf({ ...(v as object), selected: "gone" } as never), "K3");
  assert.match(src("components/Composer.tsx"), /<ModelPicker title="任务模型"/);
  assert.match(src("pages/Home.tsx"), /model: taskModels\.selected/, "首页发起任务带上所选模型");
  assert.match(src("components/ScenarioStart.tsx"), /\.\.\.\(model \? \{ model \} : \{\}\)/, "开始面板发起任务带上所选模型");
  assert.match(src("components/ModelPicker.tsx"), /v\.source !== "cloud"\) void load\(true\)/, "登录前读到的内置兜底会立即要求刷新");
});

test("设置页统一版心：所有页签同一宽度、主区预留滚动条位置", () => {
  const css = src("styles-settings.css");
  assert.match(css, /\.main \{ scrollbar-gutter: stable; \}/);
  assert.match(css, /\.set-page\.set-usage, \.set-page\.set-visibility, \.set-page\.set-admin \{ max-width: 920px; width: 100%; \}/);
});

test("首页：无固定页脚；@材料弹层直接上传（统一组件）；外层拖放遇到已处理的事件不再导入一次；默认停在上次用过的事项", () => {
  const home = src("pages/Home.tsx");
  assert.doesNotMatch(home, /全部场景试用中/);
  assert.match(home, /lastMatterOf\(open\)/);
  const c = src("components/Composer.tsx");
  assert.match(c, /<MaterialPicker/);
  assert.match(c, /if \(e\.defaultPrevented \|\| !e\.dataTransfer\.files\.length\) return;/);
  assert.match(c, /用这些文件新建事项/);
});

test("开始面板：两栏；有必填项时“这次要定的事”排在当事人之前；底部“先填写”可点并聚焦", () => {
  const s = src("components/ScenarioStart.tsx");
  assert.match(s, /<div className="ss-grid">/);
  assert.match(s, /<aside className="ss-aside"/);
  assert.match(s, /const decideFirst = card\.fields\.some\(\(f\) => f\.required && !f\.more\);/);
  assert.match(s, /\{decideFirst && decideSection\}\s*\{hasParties && partiesSection\}\s*\{!decideFirst && decideSection\}/);
  assert.match(s, /onClick=\{\(\) => focusMissing\(\)\}/);
});
