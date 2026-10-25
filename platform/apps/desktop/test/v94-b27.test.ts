/**
 * v9.4 第 27 批（精修二）界面：期限按到期日分组、……（随实施补充）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("期限按到期日分组：今天 / 7 天内 / 以后 / 已过期；cancel_pending 是有效提醒照常列出（复核 Q8-04）；组内从近到远，已过期从最近过期排起", async () => {
  const { dueBuckets } = await import("../src/lib/reminders.ts");
  const now = Date.parse("2026-10-25T04:00:00Z"); // 北京时间 10-25 中午
  const g = dueBuckets(
    [
      { due_date: "2026-11-30", cloud_state: "local" },
      { due_date: "2026-10-25", cloud_state: "local" },
      { due_date: "2026-11-01", cloud_state: "local" },
      { due_date: "2026-10-27", cloud_state: "local" },
      { due_date: "2026-11-02", cloud_state: "local" },
      { due_date: "2026-10-20", cloud_state: "local" },
      { due_date: "2026-10-24", cloud_state: "local" },
      { due_date: "2026-10-26", cloud_state: "cancelled" },
      { due_date: "2026-10-29", cloud_state: "cancel_pending" },
    ],
    now,
  );
  assert.deepEqual(
    g.map((x) => [x.label, x.items.map((i) => i.due_date)]),
    [
      ["今天到期", ["2026-10-25"]],
      ["7 天内", ["2026-10-27", "2026-10-29", "2026-11-01"]],
      ["以后", ["2026-11-02", "2026-11-30"]],
      ["已过期", ["2026-10-24", "2026-10-20"]],
    ],
  );
  assert.deepEqual(dueBuckets([], now), [], "没有提醒时不返回空组");
});

test("沿用的成果：只认 artifact.reused，同一份文件只列一次，带上第一次生成它的任务", async () => {
  const { reusedArtifacts } = await import("../src/lib/timeline.ts");
  const ev = (type: string, payload: Record<string, unknown>) => ({ event_id: `${type}${Math.random()}`, type, payload }) as any;
  assert.deepEqual(
    reusedArtifacts([
      ev("artifact.drafted", { artifact_version_id: "av_new" }),
      ev("artifact.reused", { artifact_version_id: "av_1", first_run_id: "run_a" }),
      ev("artifact.reused", { artifact_version_id: "av_1", first_run_id: "run_a" }),
      ev("artifact.reused", { artifact_version_id: "av_2" }),
      ev("artifact.reused", {}),
    ]),
    [
      { artifact_version_id: "av_1", first_run_id: "run_a" },
      { artifact_version_id: "av_2", first_run_id: null },
    ],
  );
});

test("材料没添加上：内核的中文原因照写；解析库的英文原文不上屏，换成律师话；失败单列红色并可被读屏", async () => {
  const { importFailText } = await import("../src/lib/errors.ts");
  // 走查 U3-04：界面曾写“法院传票扫描件.pdf 未添加：Invalid PDF structure.”
  const pdf = importFailText("法院传票扫描件.pdf", "Invalid PDF structure.");
  assert.ok(!/[A-Za-z]{4,}/.test(pdf.replace("法院传票扫描件.pdf", "")), pdf);
  assert.match(pdf, /打不开.*重新导出/);
  assert.match(importFailText("合同.docx", "File is password protected"), /设了密码/);
  assert.match(importFailText("a.exe", "Unsupported file type"), /暂不支持这种格式/);
  assert.match(importFailText("x.docx", "Something went wrong deep inside"), /没能读出这个文件/);
  assert.equal(importFailText("密件.docx", "材料带国家秘密标志，不能导入"), "密件.docx 没有添加：材料带国家秘密标志，不能导入", "内核的中文原因照写");
  // 复核 Q8-03：内核的中文原因里有 Word、WPS、PDF 等字样时也照写，不换成通用句
  const doc = importFailText("起诉状.doc", "这是旧版 Word 或 WPS 文字格式，本机读不了：请用 Word、WPS 或 Excel 打开它，“另存为”Word 文档（.docx）后再导入");
  assert.match(doc, /另存为/);
  assert.doesNotMatch(importFailText("邮件.msg", "Unsupported format: not a PDF or DOCX"), /PDF 打不开/, "PDF 分支只看扩展名");
  assert.ok(!/[A-Za-z]{4,}/.test(importFailText("Contract.docx", "").replace("Contract.docx", "")), "文件名里的英文不算");
  for (const f of ["../src/pages/Matter.tsx", "../src/pages/Home.tsx"]) {
    const s = read(f);
    assert.ok(!s.includes("未添加：${(e as Error).message}"), `${f} 不再把原文拼上屏`);
    assert.match(s, /role="alert"[^>]*>\{failMsg\}/);
  }
});

test("执行页处理细节说律师话：做法与输入框同名；内部步骤（Agent 宿主、沙箱、镜像、结算）与数据级别不进时间线", async () => {
  const { buildSteps } = await import("../src/lib/timeline.ts");
  const at = "2026-10-25T10:00:00+08:00";
  const steps = buildSteps([
    { event_id: 1, seq: 1, type: "agent.started", payload: { mode: "default", plan_first: true, data_level: "L2" }, created_at: at },
    { event_id: 2, seq: 2, type: "plan.created", payload: { steps: ["载入材料", "启动 Agent 宿主（独立进程，非系统沙箱）", "执行并镜像事件", "结算"] }, created_at: at },
    { event_id: 3, seq: 3, type: "agent.started", payload: { mode: "auto", data_level: "L3a" }, created_at: at },
  ] as never);
  assert.deepEqual(steps.map((s) => s.title), ["做法：先给我看计划", "做法：放手做"]);
  const text = JSON.stringify(steps);
  assert.ok(!/Agent|宿主|沙箱|镜像|结算|数据级别|L\d/.test(text), text);
  const { modeSheetText } = await import("../src/lib/mode-options.ts");
  assert.equal(modeSheetText({ mode: "default", planFirst: true }), "先给我看计划：先列出要做的步骤，你确认后再开始");
  assert.ok(!read("../src/components/RunSheet.tsx").includes("<dt>运行模式</dt>"), "确认卡不再写“运行模式”");
});

test("场景卡开始面板与开始前确认用同一块“发送什么、发给谁”；还要再确认时主按钮写“下一步”", () => {
  const ss = read("../src/components/ScenarioStart.tsx");
  assert.match(ss, /<SendPoints dataWhere=\{estimate\.estimate\.data_where\}>/);
  assert.ok(!ss.includes('preview.split("；")'), "不再把整段说明拆成一句标题 + 长段");
  assert.match(ss, /"下一步：确认" : card\.verb/);
  assert.match(read("../src/components/SendPoints.tsx"), /preview_rows\?\.length/);
});

test("没有内容标题的助手草稿用任务名命名；有标题的照旧；待签发待办与工作台协议条不带扩展名与版本号", async () => {
  const { artifactName } = await import("../src/lib/labels.ts");
  // 走查 U3-09：两次自由描述任务的成果都叫“助手草稿”
  assert.equal(artifactName({ kind: "a1_agent_draft", filename: "草稿-2026-10-25.md", title: "时间线草稿已生成。", run_goal: "根据签收单整理交货与收货的时间线，标出还缺哪些证据" }), "根据签收单整理交货与收货的时间线，标出还缺哪些证据（草稿）");
  assert.equal(artifactName({ kind: "a1_agent_draft", filename: "草稿.md", title: null, run_title: "审合同" }), "审合同（草稿）");
  assert.equal(artifactName({ kind: "a1_agent_draft_partial", filename: "草稿.md", title: null, run_title: "审合同" }), "审合同（部分完成）");
  assert.equal(artifactName({ kind: "a1_agent_draft", filename: "草稿.md", title: null }), "助手草稿", "没有任务信息时仍用固定名称");
  assert.equal(artifactName({ kind: "a1_agent_draft", filename: "草稿.md", title: "研究备忘（草稿）", run_title: "审合同" }), "研究备忘（草稿）", "有标题时用标题");
  const { agreementParts } = await import("../src/lib/workbench.ts");
  assert.deepEqual(agreementParts({ stance: "买方", method: "合同审查 v1.6.0" }), ["我方：买方", "方法：合同审查"]);
});

test("期限日写给人看：“10月28日 周三”，跨年加年份；没连提醒服务时不显示每行相同的“电脑关机时”列", async () => {
  const { dueDateText } = await import("../src/lib/reminders.ts");
  const now = Date.parse("2026-10-25T04:00:00Z");
  assert.equal(dueDateText("2026-10-28", now), "10月28日 周三");
  assert.equal(dueDateText("2027-01-04", now), "2027年1月4日 周一");
  const page = read("../src/pages/Reminders.tsx");
  assert.match(page, /\{showCloud && <th>电脑关机时<\/th>\}/);
  assert.match(page, /dueBuckets\(data\?\.reminders/);
  assert.match(page, /新提醒（\{unread\.length\}）/);
  assert.match(page, /看过的提醒（\{read\.length\}）/);
});

test("新卡：劳动仲裁申请书 / 答辩书（新方法 labor-arbitration-draft）、诉讼线案件进展报告；金额测算可复核对方计算", async () => {
  const { SCENARIOS, NEXT_STEPS } = await import("../src/lib/scenarios.ts");
  const card = (id: string) => SCENARIOS.find((c) => c.id === id)!;
  assert.equal(card("labor-arb-application").skill, "labor-arbitration-draft");
  assert.deepEqual(card("labor-arb-application").args, { doc_kind: "申请书" });
  assert.deepEqual(card("labor-arb-defense").args, { doc_kind: "答辩书", side: "用人单位" });
  assert.ok(card("labor-arb-defense").fields.find((f) => f.key === "received_on")?.required, "答辩书必须问收到日期（答辩期按工作日起算）");
  assert.match(card("labor-arb-defense").goal, /十个工作日/);
  assert.match(card("labor-response").goal, /十个工作日/);
  assert.equal(card("case-report-lit").line, "litigation");
  assert.equal(card("case-report-lit").skill, "case-report");
  assert.ok(card("amount").fields.find((f) => f.key === "mode")?.options?.includes("复核对方计算"));
  assert.ok(card("amount").fields.find((f) => f.key === "items")?.options?.includes("诉讼费用预估"));
  assert.ok(card("labor-apply").gets.includes("劳动争议应对方案.docx"), "卡上的交付件与方法实际产出同名");
  assert.equal(NEXT_STEPS["labor-apply"]![0], "labor-arb-application");
  assert.equal(NEXT_STEPS["labor-response"]![0], "labor-arb-defense");
  assert.ok(NEXT_STEPS.agency!.includes("case-report-lit"));
  // 复核 Q8-06、Q8-09
  assert.ok(card("case-report-lit").gets.includes("案件进展汇报.docx"), "与方法实际产出同名");
  assert.ok(!card("case-report-lit").fields[0]!.options!.includes("所内合伙人"));
  assert.equal(card("labor-arb-defense-lit").line, "litigation");
  assert.deepEqual(card("labor-arb-defense-lit").args, { doc_kind: "答辩书" });
});

test("视觉统一：一级框内边距一档、框内子块一档；样式表里没有 700 字重；b、strong 用 600", () => {
  const css = read("../src/styles.css");
  for (const sel of [".panel", ".card", ".widget", ".status-tile", ".today-col", ".vis-col"]) {
    const m = new RegExp(`^\\${sel} \\{[^}]*padding: ([^;]+);`, "m").exec(css);
    assert.equal(m?.[1], "var(--sp-4)", sel);
  }
  for (const sel of [".ss-sec", ".send-summary"]) assert.equal(new RegExp(`^\\${sel} \\{[^}]*padding: ([^;]+);`, "m").exec(css)?.[1], "var(--sp-3)", sel);
  assert.ok(!/font-weight:\s*(700|bold)/.test(css));
  assert.match(css, /^b, strong \{ font-weight: 600; \}/m);
});

test("首页近期期限也列 cancel_pending 的有效提醒（复核 Q8-04，原先滤掉）", async () => {
  const { upcomingDeadlines } = await import("../src/lib/reminders.ts");
  const now = Date.parse("2026-10-25T04:00:00Z");
  const got = upcomingDeadlines([{ due_date: "2026-10-28", cloud_state: "cancel_pending", matter_lifecycle: "active" }, { due_date: "2026-10-27", cloud_state: "cancelled", matter_lifecycle: "active" }], now);
  assert.deepEqual(got.map((r) => r.due_date), ["2026-10-28"]);
});

test("工作准则第 10 条：系统标识不写给律师，但方法要求的质量说明行（未经本所质量验收）必须照写（复核 Q8-07）", () => {
  const agents = readFileSync(new URL("../../../content/skills/AGENTS.md", import.meta.url), "utf8");
  assert.match(agents, /10\. \*\*写给律师的话用律师的语言。\*\*/);
  assert.match(agents, /质量说明行（如“通用辅助 · 未经本所质量验收 · 草稿待律师复核”）必须照写，不得删改/);
});

test("删除清单的说法对得上对象；数据去向说明保留根密钥的风险与缓解两句（复核 Q8-05、Q8-12）", () => {
  assert.match(read("../src/components/MatterLifecycle.tsx"), /redacted_signed_rows: "任务过程与数据去向记录里已清除内容的条目/);
  assert.match(read("../src/pages/Connections.tsx"), /根密钥目前保存在各成员的电脑上；律所版将改为线下分片保管/);
});

test("执行页的成果名用本任务的名字补（取成果的接口不带任务名）", () => {
  const rv = read("../src/pages/RunView.tsx");
  assert.match(rv, /const withRun = \(a: any\) => \(\{ \.\.\.a, run_title: a\.run_title \?\? runSnap\.title/);
  assert.equal((rv.match(/artifactName\(withRun\(a\)/g) ?? []).length, 3);
});
