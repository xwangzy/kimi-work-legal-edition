/**
 * 第 51 批：品牌两行签名、成果页复核流程条、数据去向去向图、统一等待反馈、执行页时间线、客户授权逐案留痕（D-216）与首次使用告知。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");

test("等待分级：0.3 秒内不出加载态，3 秒起给已用时间，30 秒起补说明；已用时间一种写法；有总量才给进度", async () => {
  const { waitLevel, fmtWait, countProgress, loadState } = await import("../src/lib/waiting.ts");
  assert.equal(waitLevel(200), "instant");
  assert.equal(waitLevel(1200), "short");
  assert.equal(waitLevel(12_000), "medium");
  assert.equal(waitLevel(45_000), "long");
  assert.equal(fmtWait(8_400), "8 秒");
  assert.equal(fmtWait(72_000), "1 分 12 秒");
  assert.equal(fmtWait(120_000), "2 分钟");
  assert.equal(fmtWait(-5), "0 秒");
  assert.deepEqual(countProgress(3, 12), { text: "3/12", ratio: 0.25 });
  assert.equal(countProgress(3, 0), null, "不知道总量就不画进度");
  assert.equal(countProgress(3, null), null);
  // 失败不是空：读取失败返回 error，不能当成“没有”
  assert.equal(loadState(null, "boom"), "error");
  assert.equal(loadState(null, ""), "loading");
  assert.equal(loadState([], ""), "ready");
  // 问答的已用时间复用同一写法
  const { fmtElapsed } = await import("../src/lib/chat-wait.ts");
  assert.equal(fmtElapsed(72_000), fmtWait(72_000));
});

test("首次使用 AI 的告知：只给律师本人看一次；点“先不用”不发起；读不到接口不拦；记录失败不拦", async () => {
  const { ensureAiNotice, setAiNoticeHost } = await import("../src/lib/ai-notice.ts");
  const acks: string[] = [];
  const ack = async (v: string) => void acks.push(v);
  setAiNoticeHost(async () => true);
  assert.equal(await ensureAiNotice(async () => ({ version: "n1", needs_ack: false }), ack), true);
  assert.deepEqual(acks, [], "看过了不再弹、不再记");
  assert.equal(await ensureAiNotice(async () => ({ version: "n1", needs_ack: true }), ack), true);
  assert.deepEqual(acks, ["n1"]);
  setAiNoticeHost(async () => false);
  assert.equal(await ensureAiNotice(async () => ({ version: "n2", needs_ack: true }), ack), false, "律师选“先不用”");
  assert.deepEqual(acks, ["n1"]);
  assert.equal(await ensureAiNotice(async () => Promise.reject(new Error("unknown method")), ack), true, "旧内核没有告知接口：不拦");
  setAiNoticeHost(async () => true);
  assert.equal(await ensureAiNotice(async () => ({ version: "n3", needs_ack: true }), async () => Promise.reject(new Error("x"))), true, "记录失败不拦（下次再说明）");
  setAiNoticeHost(null);
  // 接线：开始任务（场景面板与确认卡共用 launchRun）与问答发送前都要过告知
  assert.match(src("components/RunSheet.tsx"), /export async function launchRun[\s\S]{0,200}ensureAiNotice\(api\.aiNotice, api\.ackAiNotice\)/);
  assert.match(src("pages/Chat.tsx"), /ensureAiNotice\(api\.aiNotice, api\.ackAiNotice\)/);
  assert.match(src("components/AskHost.tsx"), /<AiNoticeHost \/>/);
  // 告知明说这不是客户授权
  assert.match(src("components/AiNotice.tsx"), /这是给你本人的说明，不代表客户已经授权/);
});

test("客户授权逐案留痕（D-216）：依据类型 + 出处才可记录；常用条款只预填不代记；次处理者清单变了要重新确认", async () => {
  const { initialRecord, recordReady, needsReconfirm, authorizationLine, shortRef, BASIS_REF_MAX } = await import("../src/lib/authorization.ts");
  // 没设常用条款：不替律师选
  assert.deepEqual(initialRecord(null, {}), { kind: null, ref: "", sensitive: false });
  assert.deepEqual(initialRecord({ engagement_terms: true, default_ref: null }, {}), { kind: null, ref: "", sensitive: false }, "开了预填但没写出处：仍不预选");
  // 设了常用条款：预选并预填
  assert.deepEqual(initialRecord({ engagement_terms: true, default_ref: "委托代理合同第 9 条" }, {}), { kind: "engagement_terms", ref: "委托代理合同第 9 条", sensitive: false });
  // 重新确认：沿用本事项原来的依据
  assert.deepEqual(initialRecord({ engagement_terms: true, default_ref: "模板第 9 条" }, { basis_source: "separate_consent", basis_ref: "2026-11-18 邮件" }), { kind: "separate_consent", ref: "2026-11-18 邮件", sensitive: false });
  assert.equal(recordReady({ kind: null, ref: "第 9 条", sensitive: false }, false), false, "没选依据类型");
  assert.equal(recordReady({ kind: "engagement_terms", ref: "  ", sensitive: false }, false), false, "没写出处");
  assert.equal(recordReady({ kind: "engagement_terms", ref: "x".repeat(BASIS_REF_MAX + 1), sensitive: false }, false), false, "出处超长");
  assert.equal(recordReady({ kind: "engagement_terms", ref: "第 9 条", sensitive: false }, true), false, "敏感事项要另勾单独同意");
  assert.equal(recordReady({ kind: "engagement_terms", ref: "第 9 条", sensitive: true }, true), true);
  assert.equal(needsReconfirm({ basis_notice_version: "sp-2026-01" }, "sp-2026-11"), true);
  assert.equal(needsReconfirm({ basis_notice_version: null }, "sp-2026-11"), false, "旧记录没有版本：不拦");
  assert.equal(needsReconfirm({ basis_notice_version: "sp-2026-11" }, "sp-2026-11"), false);
  assert.equal(authorizationLine({ basis_complete: true, basis_source: "engagement_terms", basis_ref: "委托代理合同第 9 条" }), "已取得 · 按委托合同条款（委托代理合同第 9 条）");
  assert.equal(authorizationLine({ basis_complete: true, basis_source: "separate_consent", basis_ref: "2026-11-18 客户邮件书面同意" }), "已取得 · 客户书面同意（2026-11-18 客户邮件书面同意）");
  assert.equal(authorizationLine({ basis_complete: true, basis_source: "engagement_terms", basis_ref: "x", basis_reconfirm: true }), "须重新确认 · AI 次处理者有变化");
  assert.equal(shortRef("委托代理合同（2026）沪律字第 123 号 第 9 条 AI 辅助与次处理者").length, 24);
  // 开始前确认：记录依据类型与出处；还没取得有两个出口
  const sheet = src("components/RunSheet.tsx");
  assert.match(sheet, /<AuthorizationRecord/);
  assert.match(sheet, /先只用本机功能/);
  assert.match(sheet, /记为客户要求不上云/);
  // 记录明说不代替客户本人的授权
  assert.match(src("components/Consent.tsx"), /不代替客户本人的授权/);
  // 设置页：常用条款只用于预填，明说不会替事项自动记录
  assert.match(src("pages/Connections.tsx"), /不会替任何事项自动记录/);
});

test("成果页：复核流程条（草稿 → 待复核 → 已签发，退回只在有时出现）；缺省停在最该处理的一段", async () => {
  const { defaultFilter, visibleStages, REVIEW_STAGES } = await import("../src/lib/deliverables.ts");
  assert.deepEqual(REVIEW_STAGES.map((s) => s.label), ["草稿", "待复核", "已签发", "已退回"]);
  assert.deepEqual(visibleStages({ rejected: 0 }).map((s) => s.key), ["draft", "pending_review", "approved"]);
  assert.deepEqual(visibleStages({ rejected: 2 }).map((s) => s.key), ["draft", "pending_review", "approved", "rejected"]);
  assert.equal(defaultFilter({ pending_review: 1, draft: 5, rejected: 1 }), "pending_review", "只差签发的最急");
  assert.equal(defaultFilter({ pending_review: 0, draft: 5, rejected: 1 }), "draft");
  assert.equal(defaultFilter({ pending_review: 0, draft: 0, rejected: 1 }), "rejected");
  assert.equal(defaultFilter({ pending_review: 0, draft: 0, rejected: 0 }), "all");
  const page = src("pages/Deliverables.tsx");
  // 读取失败如实说“没有读到”，不显示成“还没有成果”；载入用骨架
  assert.match(page, /<LoadError what="成果"/);
  assert.match(page, /<ListSkeleton cards=\{2\}/);
  // 各事项并行读取，单个失败计数提示
  assert.match(page, /Promise\.allSettled\(r\.matters\.slice\(0, 50\)\.map\(matterRows\)\)/);
  // 下载进行中禁用、换圆环（防连点存出多份、记多条）
  assert.match(src("components/ArtifactRow.tsx"), /aria-busy=\{busy\} disabled=\{busy\}/);
});

test("执行页：读到任务前不显示“排队中”；正在做是蓝点 + 已用时间；等你确认是单独节点；工作清单有真实计数", () => {
  const rv = src("pages/RunView.tsx");
  assert.match(rv, /const \[runLoaded, setRunLoaded\] = useState\(false\);/);
  assert.match(rv, /const timelineEl = !runLoaded \? \(\s*<TimelineSkeleton \/>/);
  assert.match(rv, /className="step step-you"/);
  assert.match(rv, /<RunElapsed since=\{run\.created_at\} \/>/);
  assert.match(rv, /className="progress-track"/);
  assert.match(rv, /function LiveDraft\(/);
  assert.match(rv, /behavior: scrollBehavior\(\)/, "平滑滚动受“减少动效”控制");
  const css = src("styles-run.css");
  // 时间线不再是贯穿全高的竖线：节点之间画短连线
  assert.match(css, /\.timeline \{[^}]*border-left: 0/);
  assert.match(css, /\.timeline > \.step::before/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("品牌：两行签名式组合，官方 Logomark 与文字块等高；云端控制台用同一标识（不再是文字“K”）", () => {
  const css = src("styles.css");
  // 第 55 批：改为一行组合（标识 26px + 字标 + 小标），见 b55-ui 用例
  assert.match(css, /\.brand-logo \{ width: 26px; height: 26px; \}/);
  assert.match(css, /\.brand-words \{ display: inline-flex; align-items: center;/);
  const consoleHtml = readFileSync(fileURLToPath(new URL("../../console/index.html", import.meta.url)), "utf8");
  assert.match(consoleHtml, /<svg class="logo-mark brand-mark" viewBox="0 0 180 180"/);
  assert.doesNotMatch(consoleHtml, /<span class="brand-mark" aria-hidden="true">K<\/span>/);
  const consoleAuth = readFileSync(fileURLToPath(new URL("../../console/auth.js", import.meta.url)), "utf8");
  assert.doesNotMatch(consoleAuth, /"brand-mark", "aria-hidden": "true" \}, "K"/);
  // 动效令牌在令牌文件里（组件样式不另起令牌）
  const tokens = readFileSync(fileURLToPath(new URL("../../../packages/design-tokens/src/tokens.css", import.meta.url)), "utf8");
  for (const t of ["--motion-fast", "--motion-base", "--motion-slow", "--ease-standard", "--ease-out-soft"]) assert.match(tokens, new RegExp(`${t}:`));
});
