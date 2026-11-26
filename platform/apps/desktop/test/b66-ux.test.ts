/**
 * 第 66 批（V40）界面重构的守护用例：论点确认卡的“需要你判断”与汇总、依据徽标、个人用量口径、模型选项、菜单用量行、
 * 设置页统一版心、首页去页脚与 @材料直传、拖放不重复导入、开始面板两栏与必填前置。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basisBadge } from "../src/lib/outline.ts";
import { personalView } from "../src/lib/personal-usage.ts";
import { modelChoices, modelLabelOf } from "../src/lib/model-choices.ts";
import { personalUsedRatio, quotaMenuLine } from "../src/lib/quota-notice.ts";
import type { QuotaStatus } from "../src/api.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");

// 论点确认卡的“需要你判断”清单与汇总（outlineAttention / attentionDigest）已在第 67 批（V41 工作线 A）换成每条论点一句结论信号 + 卡顶一行汇总，
// 对应用例移到 b67-outline-card.test.ts（同一组样例数据，覆盖同样的情形：依据问题、类推、待证要件、事实去重、去掉的论点与依据不算）。

test("依据徽标：核过的短标 + 原口径完整说法；未收录与核对未通过是风险", () => {
  assert.deepEqual([basisBadge({ check: "version_verified", article_text: "x", demo: false }).label, basisBadge({ check: "version_verified", article_text: "x", demo: false }).tone], ["版本已核", "ok"]);
  assert.match(basisBadge({ check: "version_verified", article_text: "x", demo: false }).detail, /是否撑得住论点由你判断/);
  assert.equal(basisBadge({ check: "intercepted", article_text: null, demo: false, matched: null }).label, "法规库未收录");
  assert.equal(basisBadge({ check: "intercepted", article_text: null, demo: false, matched: "x" }).tone, "risk");
  assert.equal(basisBadge({ check: "unchecked", article_text: null, demo: false }).label, "未核实");
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

test("开始面板：段序随业务形态（第 67 批取代第 66 批两栏）；起草类“要定的事”排在当事人之前；底部“先填写”可点并聚焦", () => {
  const s = src("components/ScenarioStart.tsx");
  // 第 67 批：右栏取消，单栏；段的顺序由 lib/card-layout.ts 按形态给出（起草：要点 → 当事人 → 材料）
  assert.doesNotMatch(s, /<aside className="ss-aside"/);
  assert.match(s, /const sectionKeys = sectionOrder\(form\)\.filter\(\(k\) => k !== "parties" \|\| hasParties\);/);
  assert.match(s, /onClick=\{\(\) => focusMissing\(\)\}/);
});
