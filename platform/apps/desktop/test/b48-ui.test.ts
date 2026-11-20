/**
 * 第 48 批：品牌标识、客户授权（D-202）、成果 / 数据去向 / 期限提醒三页重做。
 * 纯函数逐条断言；页面用源文件静态检查锁住关键接线（与既有 v18/b47 用例同一做法）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("客户授权：已取得 = 三项确认、敏感事项的特别条件仍待确认；尚未取得与不上云四项待确认", async () => {
  const { basisForChoice } = await import("../src/lib/authorization.ts");
  assert.deepEqual(basisForChoice("authorized", false), { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" });
  assert.equal(basisForChoice("authorized", true).sensitive, "pending", "敏感个人信息的单独同意不随默认确认");
  for (const c of ["pending", "local_only"] as const) assert.equal(basisForChoice(c, false).engagement, "pending");
});

test("开始任务时补记：只把待确认改为已确认，不适用保持；敏感项只在勾了单独同意时确认；要问哪几项按现有四项算", async () => {
  const { basisAfterConfirm, confirmNeeds } = await import("../src/lib/authorization.ts");
  const cur = { engagement: "pending", personal_info: "not_applicable", sensitive: "pending", subprocessor: "pending" } as const;
  assert.deepEqual(basisAfterConfirm(cur, { general: true, sensitive: false }), { engagement: "confirmed", personal_info: "not_applicable", sensitive: "pending", subprocessor: "confirmed" });
  assert.equal(basisAfterConfirm(cur, { general: true, sensitive: true }).sensitive, "confirmed");
  assert.deepEqual(confirmNeeds(cur), { general: true, sensitive: true });
  assert.deepEqual(confirmNeeds({ engagement: "confirmed", personal_info: "confirmed", sensitive: "pending", subprocessor: "confirmed" }), { general: false, sensitive: true });
  assert.deepEqual(confirmNeeds(undefined), { general: true, sensitive: false });
});

test("事项里的“客户授权”一句话：不上云优先；齐备时写记录方式", async () => {
  const { authorizationLine } = await import("../src/lib/authorization.ts");
  assert.equal(authorizationLine({ consent_status: "refused", basis_complete: false }), "客户要求不上云");
  assert.equal(authorizationLine({ data_level: "L3b", basis_complete: true }), "客户要求不上云");
  assert.equal(authorizationLine({ basis_complete: false }), "尚未记录客户授权");
  assert.equal(authorizationLine({ basis_complete: true, basis_source: "engagement_terms" }), "已取得 · 按委托合同条款");
  assert.equal(authorizationLine({ basis_complete: true, basis_source: "confirmed" }), "已取得 · 律师确认");
  assert.equal(authorizationLine({ basis_complete: true, basis_source: null }), "已取得");
});

test("开始前确认：只有 block_kind=consent 才出补记卡（L3b、不使用模型等 policy 不问同意）；新建事项不再有三选一卡片", () => {
  const sheet = src("components/RunSheet.tsx");
  assert.match(sheet, /const consentBlocked = blocked && estimate\.data_where\?\.block_kind === "consent";/);
  assert.doesNotMatch(sheet, /\?\? "consent"\) === "consent"/, "缺省不再按“去记录同意”处理");
  assert.match(sheet, /basis_source: "confirmed"/);
  const nm = src("components/NewMatter.tsx");
  assert.match(nm, /<AuthorizationField /);
  assert.match(nm, /api\s*\.aiAuthorization\(\)/);
  assert.doesNotMatch(nm, /ConsentQuestion|客户明确不同意使用云端 AI/);
  // “客户要求不上云”只在客户授权里选一处，敏感程度不再重复
  assert.doesNotMatch(nm, /v: "strict"/);
});

test("品牌：侧栏与登录页用官方 Logomark（路径不带颜色，颜色来自 --brand-mark-* 令牌）；“法律版”是从属层级", () => {
  const brand = src("components/Brand.tsx");
  assert.doesNotMatch(brand, /fill="#|#1783|#000|#fff/i, "颜色不写在路径上");
  assert.match(brand, /className="logo-mark-dot"/);
  assert.match(src("components/Sidebar.tsx"), /<BrandLockup \/>/);
  assert.match(src("pages/Activate.tsx"), /<BrandLockup edition="法律行业发行版" \/>/);
  const css = src("styles.css");
  assert.match(css, /\.logo-mark-dot \{ fill: var\(--brand-mark-dot\); \}/);
  assert.match(css, /\.brand-edition \{[^}]*color: var\(--text-label\)/);
  const tokens = readFileSync(new URL("../../../packages/design-tokens/src/tokens.css", import.meta.url), "utf8");
  assert.match(tokens, /--p-kimi-blue: #1783ff;/);
});

test("三页：成果按任务卡片、提交复核悬停出现；数据去向是去向图 + 客户授权设置（不打印）；期限按日程行", () => {
  const dl = src("pages/Deliverables.tsx");
  assert.match(dl, /className="dl-task"/);
  assert.match(dl, /placeholder="搜索文件或事项"/);
  assert.match(src("components/ArtifactRow.tsx"), /dl-hover-action/);
  const conn = src("pages/Connections.tsx");
  assert.match(conn, /<ol className="dfx-flow" aria-label="数据去向">/);
  assert.match(conn, /className="dfx-sec dfx-auth no-print"/);
  assert.match(conn, /api\.setAiAuthorization\(!state\.engagement_terms\)/);
  // 口径保留：识别会遗漏、书面确认待签署、中软保存的用量字段
  assert.match(conn, /没有识别出的姓名会按原文发出/);
  assert.match(conn, /“不用于训练、不保留”的书面确认：待签署/);
  const rm = src("pages/Reminders.tsx");
  assert.match(rm, /function agendaSummary\(/);
  assert.match(rm, /className=\{`rm-item rm-tone-\$\{tone\}`\}/);
});

test("案卷文件夹同步后的旧版本：开始任务时缺省不选（只选最新版），律师仍可自己勾", async () => {
  const { preselectDocs } = await import("../src/lib/scenarios.ts");
  const docs = [
    { document_version_id: "dv_new", filename: "合同.docx", supersedes: "dv_old" },
    { document_version_id: "dv_old", filename: "合同.docx", supersedes: null },
    { document_version_id: "dv_note", filename: "纪要.txt" },
  ];
  assert.deepEqual(preselectDocs({ minMaterials: 1, scenario: "a1.agent_task", skill: null } as never, docs), ["dv_new", "dv_note"]);
  assert.deepEqual(preselectDocs({ minMaterials: 1, scenario: "a1.agent_task", skill: "contract-review" } as never, docs), ["dv_new"]);
  assert.match(src("pages/Matter.tsx"), /!old\.has\(d\.document_version_id\)/);
  assert.match(src("pages/Home.tsx"), /!old\.has\(d\.document_version_id\)/);
});
