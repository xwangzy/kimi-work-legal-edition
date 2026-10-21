/**
 * 桌面界面的纯函数（不依赖 DOM）：
 * - 预览样式清洗（复核 S5-B15）：解开 CSS 转义与注释后判断，url() 只允许 data: 图片与字体，image-set 等一律去掉；
 * - 执行位置徽标（复核 S5-A04）：由运行状态、场景、事项端点、全部化名与在途出站生成，不靠推断。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cssHasExternalRef, scrubCss } from "../src/lib/css-scrub.ts";
import { currentBadges, type BadgeFacts } from "../src/lib/badges.ts";

test("预览样式清洗：外部引用（含转义、注释拆分、image-set、@import、src()）整条去掉；data: 图片与普通样式保留", () => {
  const external = [
    "background:url(http://tracker.invalid/a.png)",
    "background:url( 'https://tracker.invalid/a.png' )",
    "background:\\75 rl(http://tracker.invalid/a.png)",
    "background:\\000075rl(http://tracker.invalid/a.png)",
    "background:u\\rl(http://tracker.invalid/a.png)",
    "background:ur/**/l(http://tracker.invalid/a.png)",
    "background-image:image-set(\"http://tracker.invalid/a.png\" 1x)",
    "background-image:-webkit-image-set(url(http://tracker.invalid/a.png) 1x)",
    "@import 'http://tracker.invalid/x.css';",
    "@\\69mport 'http://tracker.invalid/x.css';",
    "content:image('http://tracker.invalid/a.png')",
    "background:url(//tracker.invalid/a.png)",
    "background:url(http://tracker.invalid/a.png",
    "-moz-binding:url(http://tracker.invalid/x.xml#b)",
    "width:expression(alert(1))",
  ];
  for (const css of external) {
    assert.equal(cssHasExternalRef(css), true, css);
    assert.equal(scrubCss(css), "", css);
  }
  const safe = ["color:#333;font-weight:bold", "background:url(data:image/png;base64,iVBORw0KGgo=)", "background:linear-gradient(#fff,#eee)", "font-family:'PingFang SC'"];
  for (const css of safe) {
    assert.equal(cssHasExternalRef(css), false, css);
    assert.equal(scrubCss(css), css, css);
  }
});

const base: BadgeFacts = { status: "running", scenario: "a1.agent_task", endpoint: "standard", fullPseudonym: false, inflight: { model: 0, search: 0, fetch: 0 }, openTools: [], execOpen: false };
const labels = (f: Partial<BadgeFacts>) => currentBadges({ ...base, ...f }).map((b) => b.label);

test("执行位置徽标：由事实生成——排队、恢复、预算暂停、等待各有文案；“模型推理中”只在有在途模型请求时出现，去向按端点、代号范围按全部化名", () => {
  assert.deepEqual(labels({ status: "queued" }), ["排队中"]);
  assert.deepEqual(labels({ status: "recovering" }), ["恢复中（从最后检查点继续）"]);
  assert.deepEqual(labels({ status: "budget_paused" }), ["预算暂停（等你决定）"]);
  assert.deepEqual(labels({ status: "waiting_approval" }), ["等待你确认"]);
  assert.deepEqual(labels({ status: "waiting_device" }), ["等待电脑上线"]);
  assert.deepEqual(labels({ status: "succeeded" }), []);
  // 退出模式：排队与恢复中的任务暂停（阶段 6 复核 S6-C12）；等待律师的照旧
  assert.deepEqual(labels({ status: "queued", exitMode: "license_expired" }), ["暂停（退出模式：恢复许可后自动继续）"]);
  assert.deepEqual(labels({ status: "recovering", exitMode: "license_missing" }), ["暂停（退出模式：恢复许可后自动继续）"]);
  assert.deepEqual(labels({ status: "queued", exitMode: "device_revoked" }), ["已暂停（这台电脑已被律所停用，不会继续）"], "复核 S6-C18");
  assert.deepEqual(labels({ status: "queued", exitMode: "control_plane_unconfigured" }), ["暂停（还没连上律所的服务，请联系管理员）"]);
  assert.deepEqual(labels({ status: "waiting_approval", exitMode: "license_expired" }), ["等待你确认"]);
  assert.deepEqual(labels({ status: "queued", exitMode: null }), ["排队中"]);
  // 没有在途模型请求：不写“模型推理中”
  assert.deepEqual(labels({}), ["本机处理中"]);
  assert.deepEqual(labels({ scenario: "s6.redaction" }), ["本机处理中（本场景不调用模型、不联网）"]);
  // 在途模型请求：按端点写去向，按全部化名写代号范围
  assert.match(labels({ inflight: { model: 1, search: 0, fetch: 0 } })[0]!, /AI 正在处理（经中软；证件、账户、联系方式与自然人姓名已替换为代号/);
  assert.match(labels({ inflight: { model: 1, search: 0, fetch: 0 }, fullPseudonym: true })[0]!, /自然人姓名与机构名称已替换为代号/);
  assert.match(labels({ inflight: { model: 1, search: 0, fetch: 0 }, endpoint: "byok" })[0]!, /律所自己的 Kimi 账号.*不经中软/);
  assert.match(labels({ inflight: { model: 1, search: 0, fetch: 0 }, endpoint: "private" })[0]!, /律所私有模型/);
  // 执行域与检索、抓取
  assert.deepEqual(labels({ openTools: ["Bash"] }), ["本机 · 运行时隔离（W）"]);
  assert.ok(labels({ inflight: { model: 0, search: 1, fetch: 0 } }).some((l) => l.startsWith("联网检索中")));
  assert.ok(labels({ openTools: ["FetchURL"] }).some((l) => l.startsWith("正在打开公开网页")));
});

// ─── 第 4 批复核 B 的界面纯函数 ───

const ev = (type: string, payload: Record<string, unknown>, id = 1) => ({ event_id: id, seq: id, type, payload, created_at: "2026-10-14T01:02:03.000Z" });

test("复核 B4-B07/B4-B21/B4-B23 时间线文案：取消未确认如实说“可能仍在运行”（不再写“已强制停止”）；引擎可自动重试的错误写“正在自动重试”；结束原因码转中文", async () => {
  const { buildSteps, CANCEL_UNCONFIRMED_TEXT, outcomeReasonLabel } = await import("../src/lib/timeline.ts");
  const un = buildSteps([ev("agent.cancel_unconfirmed", { agent_task_id: "k", forced: true, cause: "version_conflict", error: "引擎没有响应中止" })]);
  const lawyer = un.filter((s) => s.level === "lawyer");
  assert.deepEqual(lawyer.map((s) => s.title), [CANCEL_UNCONFIRMED_TEXT]);
  assert.match(CANCEL_UNCONFIRMED_TEXT, /可能仍在运行/);
  assert.ok(!JSON.stringify(un).includes("已强制停止"));
  assert.match(un.find((s) => s.level === "detail")!.detail!, /停止时恰好有新的确认或提问到达；引擎没有响应中止/);
  const forced = buildSteps([ev("agent.cancel_forced", { forced: true, cause: "forbidden" })]);
  assert.deepEqual(forced.map((s) => [s.level, s.title]), [["detail", "停止请求经强制方式生效（本机助手记录的发起人与当前不一致）"]]);
  const retrying = buildSteps([ev("agent.error", { code: "provider_unavailable", message: "503", retryable: true })]);
  assert.equal(retrying.find((s) => s.level === "lawyer")!.title, "AI 服务出了点问题，正在自动重试");
  const plain = buildSteps([ev("agent.error", { code: "x", message: "y", retryable: false })]);
  assert.equal(plain.find((s) => s.level === "lawyer")!.title, "这一步没有完成，任务会尽量继续");
  const outcome = buildSteps([ev("agent.outcome", { status: "partial", reason: "length_truncated" })]);
  assert.equal(outcome[0]!.title, "助手结束：部分完成（回答在长度上限处被截断）");
  assert.equal(outcomeReasonLabel("some_new_engine_code"), "其他原因", "未登记的英文原因码不直接显示");
  assert.equal(outcomeReasonLabel("用户取消"), "用户取消");
});

test("复核 B4-B15 检索改写差异：完全相同、整段替换、名称换成“某公司”、超上限退化、含代理对字符；首屏不含被去掉的名称；按改写处计数", async () => {
  const { charDiff, sendView } = await import("../src/lib/query-diff.ts");
  const same = sendView("民法典 违约金 调整", "民法典 违约金 调整");
  assert.deepEqual(same, { shown: [{ text: "民法典 违约金 调整", kind: "same" }], removedCount: 0 });
  const whole = sendView("孙悦", "某人");
  assert.equal(whole.removedCount, 1);
  assert.equal(whole.shown.map((p) => p.text).join(""), "某人");
  const named = sendView("甲科技有限公司 孙悦 股东未实缴出资", "某公司 某人 股东未实缴出资");
  const shown = named.shown.map((p) => p.text).join("");
  assert.equal(shown, "某公司 某人 股东未实缴出资", "首屏只显示将发出的改写稿");
  for (const name of ["甲科技", "孙悦"]) assert.ok(!shown.includes(name), `首屏不含被去掉的“${name}”`);
  assert.equal(named.removedCount, 2, "两处改写（公司名、人名）");
  assert.equal(sendView("张某某 合同纠纷", "某人 合同纠纷").removedCount, 1, "偶然对上的单字不把一处拆成两处");
  assert.equal(sendView("张三、李四 借款", "某人、某人 借款").removedCount, 2, "标点分隔的是两处");
  // 超上限：退化为整段删除 + 整段新增，首屏仍只显示改写稿
  const big = "甲".repeat(700);
  assert.deepEqual(charDiff(big, "乙".repeat(700)), [{ text: big, kind: "removed" }, { text: "乙".repeat(700), kind: "added" }]);
  assert.equal(sendView(big, "乙".repeat(700)).shown.map((p) => p.text).join(""), "乙".repeat(700));
  // 代理对（扩展区汉字、表情）按码点切分，不产生半个字符
  const sp = sendView("𠮷野家 𩸽", "某公司 𩸽");
  assert.equal(sp.shown.map((p) => p.text).join(""), "某公司 𩸽");
  for (const p of charDiff("𠮷野家 𩸽", "某公司 𩸽")) assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(p.text), `半个代理对：${JSON.stringify(p.text)}`);
});

test("复核 B4-B16 提问卡作答：选项与“其他”互斥；多选空选不算作答；多题须逐题作答（未选的题数写明）", async () => {
  const { buildAnswers, isAnswered, pickOption, typeOther, unansweredCount } = await import("../src/lib/question-answers.ts");
  const single = { id: "q1", question: "范围？", options: [{ id: "o1", label: "近三年" }, { id: "o2", label: "不限" }] };
  const multi = { id: "q2", question: "类型？", options: [{ id: "m1", label: "判决" }, { id: "m2", label: "裁定" }], multi_select: true };
  let d = { sel: {}, other: {} } as { sel: Record<string, string[]>; other: Record<string, string> };
  d = pickOption(d, single, "o1");
  d = typeOther(d, single, "只看北京");
  assert.deepEqual(d.sel.q1, undefined, "写“其他”即清空已选项（不再两者同时呈选中）");
  assert.deepEqual(buildAnswers([single], d), { q1: { kind: "other", text: "只看北京" } });
  d = pickOption(d, single, "o2");
  assert.equal(d.other.q1, undefined, "点选项即清空“其他”");
  assert.deepEqual(buildAnswers([single], d), { q1: { kind: "single", option_id: "o2" } });
  d = typeOther(d, single, "   ");
  assert.deepEqual(d.sel.q1, ["o2"], "只写空白不清空选项");
  // 多选：选了又取消 → 空选，不算作答
  let m = pickOption({ sel: {}, other: {} }, multi, "m1");
  m = pickOption(m, multi, "m2");
  assert.deepEqual(buildAnswers([multi], m), { q2: { kind: "multi", option_ids: ["m1", "m2"] } });
  m = pickOption(pickOption(m, multi, "m1"), multi, "m2");
  assert.equal(isAnswered([multi], m), false);
  assert.deepEqual(buildAnswers([multi], m), { q2: { kind: "skipped" } });
  // 多题部分作答：不可提交，写明还有几题
  const part = pickOption({ sel: {}, other: {} }, single, "o1");
  assert.equal(isAnswered([single, multi], part), false);
  assert.equal(unansweredCount([single, multi], part), 1);
  assert.equal(isAnswered([single, multi], pickOption(part, multi, "m2")), true);
});

test("复核 B4-B17 更新横幅：有任务时不给“现在重启”且随任务数实时变化；“稍后”按版本记住；未通过核验的横幅可关闭并按版本记住", async () => {
  const { updateBannerView } = await import("../src/lib/update-banner.ts");
  const ready = { state: "ready", version: "1.2.0", laterVersion: null, rejectedSeenVersion: null };
  assert.deepEqual(updateBannerView({ ...ready, activeRuns: 0 }), { kind: "ready", canInstall: true, busyNote: false, dismissLabel: "稍后（关闭应用时自动更新）" });
  assert.deepEqual(updateBannerView({ ...ready, activeRuns: 2 }), { kind: "ready", canInstall: false, busyNote: true, dismissLabel: "知道了（关闭应用时自动更新）" });
  assert.equal(updateBannerView({ ...ready, laterVersion: "1.2.0", activeRuns: 0 }), null);
  assert.equal(updateBannerView({ ...ready, laterVersion: "1.1.0", activeRuns: 0 })?.kind, "ready", "旧版本的“稍后”不影响新版本");
  const rej = { state: "rejected", version: "1.3.0", laterVersion: null, activeRuns: 0 };
  assert.deepEqual(updateBannerView({ ...rej, rejectedSeenVersion: null }), { kind: "rejected" });
  assert.equal(updateBannerView({ ...rej, rejectedSeenVersion: "1.3.0" }), null);
  assert.deepEqual(updateBannerView({ ...rej, rejectedSeenVersion: "1.2.9" }), { kind: "rejected" });
  assert.equal(updateBannerView({ state: "downloading", version: "1.3.0", laterVersion: null, rejectedSeenVersion: null, activeRuns: 0 }), null);
});

test("复核 B4-B13 发起被拦的提示与入口：409 带进行中任务编号才给入口；记录同意后仍不能开始时按原因提示", async () => {
  const { afterConsentNotice, busyRunOfError } = await import("../src/lib/start-block.ts");
  assert.equal(busyRunOfError({ code: "conflict", message: "还有一个任务在进行", detail: { run_id: "run_1" } }), "run_1");
  assert.equal(busyRunOfError({ code: "conflict", message: "版本已变化" }), null);
  assert.equal(busyRunOfError({ code: "validation", detail: { run_id: "run_1" } }), null);
  assert.equal(busyRunOfError(null), null);
  assert.match(afterConsentNotice(undefined, false), /逐项调整/);
  assert.match(afterConsentNotice("consent", true), /敏感信息特别条件/);
  for (const k of ["busy", "exit_mode"]) assert.doesNotMatch(afterConsentNotice(k, false), /逐项调整/, `${k} 不提示去逐项调整`);
});

test("事项列表（v9.2 §4.4；Y4 M-1）：相对时间与进展胶囊", async () => {
  const { fmtRelative, matterProgress } = await import("../src/lib/labels.ts");
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(fmtRelative("2026-10-14T11:59:40Z", now), "刚刚");
  assert.equal(fmtRelative("2026-10-14T11:15:00Z", now), "45 分钟前");
  assert.equal(fmtRelative("2026-10-14T07:00:00Z", now), "5 小时前");
  assert.equal(fmtRelative("2026-10-13T10:00:00Z", now), "昨天");
  assert.equal(fmtRelative("2026-10-04T10:00:00Z", now), "10 天前");
  assert.match(fmtRelative("2026-01-04T10:00:00Z", now), /^1月[34]日$/);
  assert.match(fmtRelative("2025-01-04T10:00:00Z", now), /^2025年1月[34]日$/);
  assert.equal(fmtRelative(null, now), "—");
  assert.deepEqual(matterProgress({ waiting: 1, running: 2, pending_review: 3 }).map((p) => p.text), ["1 项等你确认", "2 个任务进行中", "3 份待签发"]);
  assert.deepEqual(matterProgress({ waiting: 0, running: 0 }), []);
});
