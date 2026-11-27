/**
 * 2026-11 产品打磨：首页对照 Kimi 首页重做版式、正式产品去掉演示数据、首次上手指南。
 * - 指南：五步、按律师工作顺序、每步都有真实锚点、文字简短且不出现研发用语；只在“没看过 + 首页 + 还没有自己的事项”时自动打开；
 *   “看过了”按律所与成员分开记；说明卡位置计算（侧栏右侧 / 下方 / 上方 / 居中）。
 * - 首页：字标 + 输入框（上方提示条、下方托盘）+ 业务线页签与场景胶囊；示例事项只在内核演示开关打开时放入。
 * - 安装包形态的内核环境不带演示开关（ZR_DEMO_SAMPLES 不在白名单里），正式产品永远不放演示数据。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { GUIDE_STEPS, guideSeen, guideSeenKey, markGuideSeen, placeCard, shouldAutoOpenGuide, stepCounter, unionRect } from "../src/lib/guide-steps.ts";

const require = createRequire(import.meta.url);
const SRC = join(import.meta.dirname, "..", "src");
const src = (p: string) => readFileSync(join(SRC, p), "utf8");

test("上手指南：五步，按“建事项 → 发起任务 → 复核成果 → 期限与问答”的顺序，内容简短", () => {
  assert.deepEqual(
    GUIDE_STEPS.map((s) => s.key),
    ["welcome", "matter", "task", "review", "keep"],
  );
  for (const s of GUIDE_STEPS) {
    assert.ok(s.title.length <= 20, `标题一句话：${s.title}`);
    assert.ok(s.body.length <= 72, `说明一两句：${s.title}（${s.body.length} 字）`);
    assert.doesNotMatch(`${s.title}${s.body}`, /执行域|跨边界|出站闸门|Playbook|确定性工作流|检索上游|事项账本|计点|令牌|沙箱|Agent/, s.key);
  }
  assert.deepEqual(GUIDE_STEPS[0]!.anchors, [], "欢迎页居中");
  assert.equal(stepCounter(1), "2 / 5");
});

test("上手指南：每个锚点都在界面上真实存在（data-tour）", () => {
  const ui = ["components/Sidebar.tsx", "components/Composer.tsx", "pages/Home.tsx"].map(src).join("\n");
  for (const a of GUIDE_STEPS.flatMap((s) => s.anchors)) {
    const literal = ui.includes(`data-tour="${a}"`);
    const navKey = a.startsWith("nav-") && /data-tour=\{`nav-\$\{it\.key\}`\}/.test(ui) && new RegExp(`key: "${a.slice(4)}"`).test(src("components/Sidebar.tsx"));
    assert.ok(literal || navKey, `锚点 ${a} 不存在`);
  }
});

test("上手指南：只在没看过、在首页、还没有自己的事项、不需要登录时自动打开", () => {
  const base = { seen: false, onHome: true, ownMatters: 0, loginRequired: false };
  assert.equal(shouldAutoOpenGuide(base), true);
  assert.equal(shouldAutoOpenGuide({ ...base, seen: true }), false);
  assert.equal(shouldAutoOpenGuide({ ...base, onHome: false }), false, "开通向导、设置页等不弹");
  assert.equal(shouldAutoOpenGuide({ ...base, ownMatters: 2 }), false, "已经在用的人不打扰");
  assert.equal(shouldAutoOpenGuide({ ...base, loginRequired: true }), false);
});

test("上手指南：“看过了”按律所与成员分开记；存储不可用时按没看过、不抛错", () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  const a = guideSeenKey("firm-a", "lawyer-1");
  const b = guideSeenKey("firm-a", "lawyer-2");
  assert.notEqual(a, b);
  assert.match(a, /^kwl\.guide\.v1\.[0-9a-f]{8}$/, "键里只有摘要，不写律所、成员标识原文");
  assert.equal(a, guideSeenKey("firm-a", "lawyer-1"), "同一人每次算出同一个键");
  assert.equal(guideSeen(store, a), false);
  markGuideSeen(store, a);
  assert.equal(guideSeen(store, a), true);
  assert.equal(guideSeen(store, b), false, "同一台电脑换人登录各看各的");
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(guideSeen(broken, a), false);
  assert.doesNotThrow(() => markGuideSeen(broken, a));
  assert.equal(guideSeen(null, a), false);
});

test("上手指南：说明卡放在侧栏右侧 / 锚点下方 / 上方，放不下时居中；不出视口", () => {
  const view = { width: 1440, height: 900 };
  const card = { width: 340, height: 180 };
  const side = placeCard({ left: 8, top: 100, width: 224, height: 36 }, view, card);
  assert.equal(side.side, "right");
  assert.ok(side.left >= 232 && side.top >= 12);
  const below = placeCard({ left: 450, top: 300, width: 770, height: 200 }, view, card);
  assert.equal(below.side, "below");
  assert.equal(below.top, 514);
  const above = placeCard({ left: 450, top: 600, width: 770, height: 250 }, view, card);
  assert.equal(above.side, "above");
  assert.ok(above.top + card.height <= 600);
  assert.equal(placeCard(null, view, card).side, "center");
  assert.equal(placeCard({ left: 0, top: 0, width: 1440, height: 900 }, view, card).side, "center");
  const u = unionRect([
    { left: 10, top: 10, width: 100, height: 20 },
    { left: 50, top: 60, width: 100, height: 20 },
    { left: 0, top: 0, width: 0, height: 0 },
  ]);
  assert.deepEqual(u, { left: 10, top: 10, width: 140, height: 70 });
  assert.equal(unionRect([]), null);
});

test("首页（Kimi 版式；第 47 批）：字标、输入框上方提示条与下方托盘、推荐 + 业务线胶囊与场景列表、页脚一行", () => {
  const home = src("pages/Home.tsx");
  assert.match(home, /className="home-wordmark"/);
  assert.match(home, /notice=\{notice\}/, "额度提示与等你处理放到输入框上方提示条");
  assert.match(home, /className="scene-chips"/);
  assert.match(home, /className="scene-list"/);
  assert.match(home, /const CHIP_LIMIT = 6;/);
  assert.match(home, /HOME_TABS: HomeTab\[\] = \["recommended", "litigation", "transactional", "inhouse", "general"\]/);
  // 第 66 批：首页固定页脚去掉（说明按场景出现）
  assert.doesNotMatch(home, /className="home-foot"/);
  assert.doesNotMatch(home, /className="cards scenario-cards"/, "首屏不再放大块卡片网格");
  const composer = src("components/Composer.tsx");
  assert.match(composer, /className="composer-notice"/);
  assert.match(composer, /className="tray-btn"/);
  const css = src("styles.css");
  assert.match(css, /\.composer \{[^}]*border-radius: var\(--radius-input\)[^}]*box-shadow: var\(--shadow-composer\)/);
  assert.match(css, /\.shell-main \{[^}]*border-radius: var\(--r-md\)/, "主区是嵌在底色上的圆角面板");
  assert.match(css, /\.scene-chip \{[^}]*border-radius: var\(--r-full\)[^}]*height: 36px|\.scene-chip \{[^}]*height: 36px[^}]*border-radius: var\(--r-full\)/);
});

test("侧栏（Kimi 版式）：新建任务胶囊、可手动收起并记住、事项分组旁有“全部”", () => {
  const sb = src("components/Sidebar.tsx");
  assert.match(sb, /nav-new/);
  assert.match(sb, /const COLLAPSE_KEY = "kwl\.sidebar\.collapsed";/);
  assert.match(sb, /aria-label="收起侧栏"/);
  assert.match(sb, /aria-label="展开侧栏"/);
  assert.match(sb, /nav\("\/matters"\)/);
});

test("正式产品不放演示数据：首页只在内核演示开关打开时放示例；设置页无开关时不显示示例一行；开通向导不再提示例", () => {
  const home = src("pages/Home.tsx");
  assert.match(home, /st\?\.demo_samples === true \? api\.installSample\(\) : null/);
  assert.doesNotMatch(home, /\.then\(\(\) => api\.installSample\(\)\)/);
  assert.match(src("pages/Connections.tsx"), /st\.available !== false && !st\.litigation_offered/);
  assert.doesNotMatch(src("pages/Welcome.tsx"), /首页会放一件虚构的示例事项/);
  // 第 72 批（D-302 第 4 条）：讲解早已不自动弹出，“进入首页后会用一分钟带你认识…”的承诺删掉
  assert.doesNotMatch(src("pages/Welcome.tsx"), /会用一分钟带你认识/);
  assert.match(src("pages/Connections.tsx"), /new Event\(OPEN_GUIDE\)/, "设置 · 通用里可以再看一遍指南");
});

test("安装包形态的内核环境不带演示开关（ZR_DEMO_SAMPLES 被白名单剔除）", () => {
  const { packagedKernelEnv } = require("../electron/release-config.cjs");
  const env = packagedKernelEnv({ PATH: "/usr/bin", ZR_DEMO_SAMPLES: "1", ZR_MODEL_PROVIDER: "mock" }, { env: {} });
  assert.equal(env.ZR_DEMO_SAMPLES, undefined);
  assert.equal(env.ZR_MODEL_PROVIDER, "upstream", "安装包形态模型固定走真实上游，不会以离线模拟运行");
});
