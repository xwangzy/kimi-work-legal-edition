/**
 * 第 46 批（主文 §5，D-195）客户端产品化修补的界面侧：发起前检查的提示与入口、上手清单、试用版文案、换电脑批准文案、正式包强制 release.json。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startHintActionLabel, startHintOf, startHintTarget } from "../src/lib/start-block.ts";
import { CHECKLIST, checklistAction, checklistCounter, checklistItems, checklistKey, checklistState, checklistVisibility, setChecklistState, type GuideProgress } from "../src/lib/guide-checklist.ts";
import { GUIDE_STEPS, guideSeenKey } from "../src/lib/guide-steps.ts";
import { userCardText } from "../src/lib/user-card.ts";

const SRC = join(import.meta.dirname, "..", "src");
const src = (p: string) => readFileSync(join(SRC, p), "utf8");

test("发起前检查的提示：从估价结果或发起错误里取出，入口是“去登录 / 查看本所用量”", () => {
  const hint = { kind: "quota", code: "quota_exhausted", message: "本所本月 AI 额度已用完：请联系律所管理员加量；下期自动重置", action: "usage" };
  assert.deepEqual(startHintOf(hint), hint);
  assert.deepEqual(startHintOf({ start_hint: hint }), hint);
  const err = Object.assign(new Error(hint.message), { code: "conflict", detail: { reason: "quota_exhausted", start_hint: hint } });
  assert.deepEqual(startHintOf(err), hint, "runs.start 拒绝时的 detail.start_hint");
  assert.equal(startHintOf(new Error("别的错误")), null);
  assert.equal(startHintOf({ start_hint: { kind: "x", message: "m" } }), null);
  assert.equal(startHintActionLabel(hint as never), "查看用量");
  assert.deepEqual(startHintTarget(hint as never), { path: "/connections/usage", anchor: "#sec-usage" });
  const login = startHintOf({ kind: "login", code: "session_expired", message: "登录已失效：请先在页面顶部重新登录，再开始任务", action: "login" })!;
  assert.equal(startHintActionLabel(login), "去登录");
  // 第 64 批：登录失效改为整窗重新登录页——“去登录”让外壳重新取登录状态并定位到那一页的输入框
  assert.deepEqual(startHintTarget(login), { path: null, anchor: '[data-auth-page="relogin"] input', refreshAccount: true });
  assert.equal(startHintActionLabel({ ...login, action: null }), null);
  // 用量页上真有这个锚点；登录横幅里真有登录框
  // 第 66 批：锚点在个人“套餐与用量”页的根节点上
  assert.match(src("pages/PersonalUsage.tsx"), /id="sec-usage"/);
  assert.match(src("App.tsx"), /if \(login\)\s*return \(\s*<>\s*<ReloginPage/);
});

test("开始前确认与开始面板：登录、额度拦下时显示橙色可操作提示，不当红色报错", () => {
  const sheet = src("components/RunSheet.tsx");
  assert.match(sheet, /<StartHintBanner hint=\{hint\} onAction=\{onClose\} \/>/);
  assert.match(sheet, /errHint && <StartHintBanner hint=\{errHint\}/);
  assert.match(sheet, /const h = startHintOf\(e\);/);
  const ss = src("components/ScenarioStart.tsx");
  assert.match(ss, /startHintOf\(estimate\.estimate\.data_where\?\.start_hint\)/);
  assert.match(ss, /errHint && <StartHintBanner/);
  const banner = src("components/StartHint.tsx");
  assert.match(banner, /className="banner banner-orange start-hint"/);
  assert.doesNotMatch(banner, /banner-red/);
});

const P = (o: Partial<GuideProgress> = {}): GuideProgress => ({ own_matters: 0, materials: 0, runs: 0, deliverables: 0, latest_matter_id: null, latest_run: null, ...o });

test("上手清单：按真实数据打勾，顺序是 建事项 → 加材料 → 发起任务 → 复核成果 → 备份这台电脑（第 72 批 D-302 加第五项）", () => {
  assert.deepEqual(CHECKLIST.map((c) => c.key), ["matter", "material", "task", "result", "backup"]);
  for (const c of CHECKLIST) {
    assert.ok(c.title.length <= 10 && c.body.length <= 30, c.key);
    assert.doesNotMatch(`${c.title}${c.body}`, /执行域|出站闸门|令牌|Agent|计点|点数/);
  }
  assert.deepEqual(checklistItems(P()).map((i) => i.done), [false, false, false, false, false]);
  assert.deepEqual(checklistItems(P({ own_matters: 1, materials: 2 })).map((i) => i.done), [true, true, false, false, false]);
  assert.equal(checklistCounter(checklistItems(P({ own_matters: 1, materials: 2, runs: 1 }))), "已完成 3 / 5");
  // 备份：没有材料时不点亮（之前没有可丢的数据）；有恢复包且设了备份位置才算完成
  assert.equal(checklistItems(P()).at(-1)!.locked, true);
  assert.equal(checklistItems(P({ own_matters: 1, materials: 1 })).at(-1)!.locked, undefined);
  assert.equal(checklistItems(P({ materials: 1 }), { packages_created: 1, configured: true }).at(-1)!.done, true);
  assert.equal(checklistItems(P({ materials: 1 }), { packages_created: 1, configured: false }).at(-1)!.done, false);
});

test("上手清单：“去做”直达对应界面", () => {
  // 第 72 批（D-301 合流）：第一步“建事项”= 写任务、按发送时就地新建
  assert.deepEqual(checklistAction("matter", P()), { kind: "composer" });
  assert.deepEqual(checklistAction("backup", P()), { kind: "nav", path: "/connections/backup" });
  assert.deepEqual(checklistAction("material", P()), { kind: "new_matter" }, "还没有事项：先建事项");
  assert.deepEqual(checklistAction("material", P({ own_matters: 1, latest_matter_id: "mat_1" })), { kind: "nav", path: "/matter/mat_1" });
  assert.deepEqual(checklistAction("task", P({ own_matters: 1 })), { kind: "composer" });
  assert.deepEqual(checklistAction("result", P({ latest_run: { run_id: "run_1", matter_id: "mat_1" } })), { kind: "nav", path: "/run/run_1/mat_1" });
  assert.deepEqual(checklistAction("result", P()), { kind: "nav", path: "/deliverables" });
});

test("上手清单：第一次见到就显示；老用户（四项都已完成）不打扰；收起后按账号分键记住；存储不可用不抛错", () => {
  assert.equal(checklistVisibility(null, P()), "show");
  assert.equal(checklistVisibility(null, P({ own_matters: 3, materials: 5, runs: 2, deliverables: 4 })), "retire");
  assert.equal(checklistVisibility("shown", P({ own_matters: 3, materials: 5, runs: 2, deliverables: 4 })), "show", "做完后显示完成态，可收起");
  assert.equal(checklistVisibility("hidden", P()), "hide");
  assert.equal(checklistVisibility(null, null), "hide", "进度没取到不显示");
  assert.notEqual(checklistKey("firm-a", "zhang"), checklistKey("firm-a", "li"));
  assert.match(checklistKey("firm-a", "zhang"), /^kwl\.checklist\.v1\.[0-9a-f]{8}$/);
  assert.doesNotMatch(checklistKey("firm-a", "zhang"), /firm-a|zhang/, "键里不写身份原文");
  assert.equal(checklistKey("f", "u").slice(-8), guideSeenKey("f", "u").slice(-8), "与“看过指南”同一摘要");
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  setChecklistState(store, checklistKey("f", "u"), "hidden");
  assert.equal(checklistState(store, checklistKey("f", "u")), "hidden");
  assert.equal(checklistState(store, checklistKey("f", "v")), null);
  const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
  assert.equal(checklistState(broken, "k"), null);
  assert.doesNotThrow(() => setChecklistState(broken, "k", "shown"));
});

test("上手清单：首页渲染卡片；按“自己建的”判断（内核 guide.progress）；聚光讲解改由“看看界面”打开、不再自动弹出", () => {
  // 第 72 批第二轮：展开与否由首页掌握（展开在输入框上方、收起在下方）
  assert.match(src("pages/Home.tsx"), /<GuideChecklist onNewMatter=\{\(\) => setNewMatter\(true\)\} expanded=\{guideExpanded\} onExpanded=\{setGuideExpanded\} \/>/);
  const card = src("components/GuideChecklist.tsx");
  assert.match(card, /api\s*\.guideProgress\(\)/);
  assert.match(card, /new Event\(OPEN_GUIDE\)/);
  assert.match(card, />\s*界面导览\s*</); // 第 72 批第二轮（设计评分 C1）：“看看界面”说不清会发生什么，改“界面导览”
  assert.doesNotMatch(card, /localStorage/, "本机存储经 App.tsx 的 safeStorage（登记过的文件）");
  const app = src("App.tsx");
  assert.doesNotMatch(app, /shouldAutoOpenGuide\(/);
  assert.doesNotMatch(app, /主进程与开发桥目前不转发这条广播/, "过时注释已改");
  const kernel = readFileSync(join(import.meta.dirname, "../../../packages/kernel/src/api/index.ts"), "utf8");
  // 第 73 批：第 1 步按“我在其中的事项”算（含同事加进来的团队共享事项），另给自己建的数（created_by）
  assert.match(kernel, /"guide\.progress": \(_p, id\) => \{[\s\S]{0,600}JOIN matter_members mm ON mm\.matter_id = m\.matter_id AND mm\.user_id = \?[\s\S]{0,400}m\.created_by === id\.userId/);
  // 第 5 步说“左下角是账号、备份与设置”：一并框出设置入口
  assert.deepEqual(GUIDE_STEPS.at(-1)!.anchors, ["nav-reminders", "nav-chat", "settings"]);
  assert.match(src("components/Sidebar.tsx"), /data-tour="settings"/);
});

test("试用版：账号、用量、用户卡、关于不写“开发形态”", () => {
  assert.equal(userCardText({ name: "试用律师", firm: null, edition: "trial" }, { title: "本机运行", note: "" }).firm, "试用版");
  assert.equal(userCardText({ name: "我", firm: null }, { title: "本机运行", note: "" }).firm, "开发形态", "真正的开发形态照旧");
  assert.match(src("components/AccountPanel.tsx"), /st\.edition === "trial" \? "试用版：不需要登录账号。"/);
  assert.match(src("pages/Connections.tsx"), /st\?\.edition === "trial" \? "试用版"/);
  assert.match(readFileSync(join(import.meta.dirname, "../electron/trial-mode.cjs"), "utf8"), /ZR_TRIAL_BUILD: "1"/);
});

test("执行页处理细节：不再出现“出错代码 provider.xxx”", () => {
  const tl = src("lib/timeline.ts");
  assert.doesNotMatch(tl, /title: "出错代码"/);
  assert.match(tl, /title: "出错详情已记录"/);
});

test("打包：正式构建（非试用、非测试包）缺 release.json 直接失败并提示先生成；开发、试用、CI 测试包照旧", () => {
  const script = readFileSync(join(import.meta.dirname, "../../../scripts/package-desktop.mjs"), "utf8");
  const body = /function releaseMissingFailure\(o\) \{([\s\S]*?)\n\}/.exec(script)?.[1];
  assert.ok(body, "门禁函数在");
  const gate = new Function("o", body!) as (o: Record<string, unknown>) => string | null;
  const formal = { hasRelease: false, trial: false, devBuild: false, sign: "env", pubDev: false };
  assert.match(gate(formal)!, /缺少 apps\/desktop\/electron\/release\.json：先用 scripts\/make-release-config\.mjs/);
  assert.equal(gate({ ...formal, hasRelease: true }), null);
  assert.equal(gate({ ...formal, trial: true }), null, "试用构建与 release.json 互斥");
  assert.equal(gate({ ...formal, devBuild: true }), null);
  assert.equal(gate({ ...formal, sign: "none" }), null);
  assert.equal(gate({ ...formal, sign: "dev" }), null);
  assert.equal(gate({ ...formal, pubDev: true }), null, "CI 用测试证书 + 开发内容公钥：测试包");
  assert.match(script, /const missing = releaseMissingFailure\(\{ hasRelease: !!rel, trial: !!trial, devBuild, sign, pubDev \}\);\n\s*if \(missing\) throw new Error\(missing\);/);
});

test("打包：构建机用户目录扫描只豁免上游预编译的 @napi-rs/canvas-<平台> 包（第 54 批 Windows 运行器实测误报），其余照旧失败", () => {
  const script = readFileSync(join(import.meta.dirname, "../../../scripts/package-desktop.mjs"), "utf8");
  const body = /function upstreamPrebuiltPath\(rel\) \{([\s\S]*?)\n\}/.exec(script)?.[1];
  assert.ok(body, "豁免判定函数在");
  const exempt = new Function("rel", body!) as (rel: string) => boolean;
  assert.equal(exempt("runtime\\parse\\node_modules\\@napi-rs\\canvas-win32-x64-msvc\\skia.win32-x64-msvc.node"), true, "Windows 运行器上报的那一个文件");
  assert.equal(exempt("runtime/parse/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node"), true);
  assert.equal(exempt("runtime/parse/node_modules/@napi-rs/canvas/index.js"), false, "主包是 JS，不豁免");
  assert.equal(exempt("runtime/w/node_modules/node-liblzma/build/Release/node_lzma.node"), false, "本机从源码编译的原生插件不豁免");
  assert.equal(exempt(".stage/app/electron/kernel.bundle.cjs"), false);
  // 只有撞上的文件才走豁免判定，判定在扫描循环里
  assert.match(script, /\(upstreamPrebuiltPath\(p\.slice\(desktop\.length \+ 1\)\) \? upstream : leaks\)\.push/);
  assert.match(script, /if \(leaks\.length\) throw new Error\(`安装包内容含构建机用户目录路径/);
});
