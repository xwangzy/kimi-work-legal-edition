/**
 * V18 A1/A2：任务完成后“结果在上、过程收起”；成果列表每份文件只列最新版、旧版进版本记录、答复摘要与复核意见归过程文件。
 * 用例数据取自 11-12 账本的两单真实任务（定向修订一单登记 14 份、审合同一单 10 份）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileCount, fileNameKey, fileTypeLabel, isPrimaryFile, splitTaskFiles } from "../src/lib/deliverables.ts";
import { artifactOptionOrder, currentFiles } from "../src/lib/run-pane.ts";
import { artifactName, fileListName } from "../src/lib/labels.ts";
import { durationText, problemSteps, processSummary, type Step } from "../src/lib/timeline.ts";

const C = "会员数据平台技术服务合同（数衡云智提供稿）";
let n = 0;
const row = (kind: string, filename: string, version: number, is_latest: boolean, kind_version = version) => ({
  artifact_version_id: `a${++n}`,
  kind,
  filename,
  version,
  kind_version,
  is_latest,
  audience: "internal",
  status: "draft",
  created_at: `2026-11-12T15:${String(40 + kind_version).padStart(2, "0")}:00Z`,
});

// 定向修订：修订工具 1 分钟内写了三轮，每轮修订稿、对外版、清洁稿、修改对照表各一份；另有答复摘要与独立复核意见
const redline = [
  row("a1_agent_draft", "草稿-2026-11-12.md", 1, true),
  row("a1_review_note", `独立复核意见-${C}（清洁稿）.md`, 1, true),
  ...[3, 2, 1].map((v) => row("agent_report", `${C}（修改对照表）.docx`, v, v === 3)),
  ...[3, 2, 1].map((v) => row("revision_clean", `${C}（清洁稿）.docx`, v, v === 3)),
  ...[3, 2, 1].flatMap((v) => [row("revision_draft", `${C}（修订稿·对外版）.docx`, v, v === 3, v * 2), row("revision_draft", `${C}（修订稿）.docx`, v, v === 3, v * 2 - 1)]),
];

test("定向修订 14 份 → 4 份文件 + 2 份过程文件；对外版与内部修订稿分开、各带 2 个旧版", () => {
  assert.equal(redline.length, 14);
  const s = splitTaskFiles(redline);
  assert.equal(s.files.length, 4);
  assert.equal(s.process.length, 2);
  for (const e of s.files) {
    assert.equal(e.latest.version, 3, "最新版是第 3 版");
    assert.equal(e.latest.is_latest, true);
    assert.deepEqual(e.older.map((x) => x.version), [2, 1], "旧版新的在前");
  }
  assert.equal(fileCount(s.files), 4);
  assert.deepEqual(s.process.map((e) => e.latest.kind), ["a1_agent_draft", "a1_review_note"], "答复摘要在前、复核意见其次");
  // 名称：修订稿按文件名显示，对外版与内部稿分得清（原来两者都叫“修订稿（Word 修订痕迹）”）
  const names = s.files.map((e) => artifactName(e.latest));
  assert.ok(names.includes(`${C}（修订稿·对外版）`) && names.includes(`${C}（修订稿）`) && names.includes(`${C}（清洁稿）`), names.join("|"));
  assert.ok(!names.some((x) => /\.docx$/.test(x)), "不带扩展名");
});

test("审合同：意见书 4 版、问题清单 3 版、答复摘要 2 版 → 主交付物第一、过程文件不进交付文件", () => {
  const rows = [
    row("agent_report", "审查意见书（内部稿）-会员数据平台技术服务合同.docx", 1, false),
    row("agent_table", "问题清单-会员数据平台技术服务合同.xlsx", 1, false),
    row("agent_report", "审查意见书（内部稿）-会员数据平台技术服务合同.docx", 2, false),
    row("a1_agent_draft", "草稿-2026-11-12.md", 1, false),
    row("a1_review_note", "独立复核意见-审查意见书（内部稿）-会员数据平台技术服务合同.md", 1, true),
    row("agent_report", "审查意见书（内部稿）-会员数据平台技术服务合同.docx", 3, false),
    row("agent_table", "问题清单-会员数据平台技术服务合同.xlsx", 2, false),
    row("agent_report", "审查意见书（内部稿）-会员数据平台技术服务合同.docx", 4, true),
    row("agent_table", "问题清单-会员数据平台技术服务合同.xlsx", 3, true),
    row("a1_agent_draft", "草稿-2026-11-12.md", 2, true),
  ];
  const c = currentFiles(rows, { primary: "问题清单.xlsx" });
  assert.deepEqual(c.current.map((x) => x.filename), ["问题清单-会员数据平台技术服务合同.xlsx", "审查意见书（内部稿）-会员数据平台技术服务合同.docx"], "主交付物排第一（即使是表格）");
  assert.equal(c.older, 5);
  assert.equal(c.process.length, 2);
  assert.equal(c.process[0]!.version, 2, "答复摘要取最新一版");
  // 取不到主交付物：文书 → 表格
  assert.deepEqual(currentFiles(rows).current.map((x) => x.kind), ["agent_report", "agent_table"]);
  // 右栏下拉：交付文件最新版 → 旧版 → 过程文件
  const o = artifactOptionOrder(rows);
  assert.deepEqual(o.map((x) => x.group), ["file", "file", "older", "older", "older", "older", "older", "process", "process", "process"]);
  assert.equal(o[0]!.row.version, 4, "默认选中主交付物的最新版");
  assert.equal(o.filter((x) => x.old).length, 6);
  // 成果页传入的是新到旧，排出来的顺序一样
  assert.deepEqual(splitTaskFiles([...rows].reverse()).files.map((e) => e.latest.artifact_version_id), splitTaskFiles(rows).files.map((e) => e.latest.artifact_version_id));
});

test("没有 is_latest 时按 种类 + 受众 + 文件名 归并、版本号最大的最新；受众不同不是同一份；文件名末尾日期不算身份", () => {
  const rows = [
    { artifact_version_id: "1", kind: "agent_report", filename: "律师函-2026-11-10.docx", version: 1, audience: "internal" },
    { artifact_version_id: "2", kind: "agent_report", filename: "律师函-2026-11-11.docx", version: 2, audience: "internal" },
    { artifact_version_id: "3", kind: "agent_report", filename: "律师函-2026-11-11.docx", version: 1, audience: "client" },
  ];
  const s = splitTaskFiles(rows);
  assert.equal(s.files.length, 2);
  assert.equal(s.files[0]!.latest.artifact_version_id, "2");
  assert.deepEqual(s.files[0]!.older.map((x) => x.artifact_version_id), ["1"]);
  assert.equal(fileNameKey("草稿-2026-11-12-部分完成.md"), "草稿.md");
  // 部分完成的答复与完整答复是同一份答复
  const p = splitTaskFiles([
    { artifact_version_id: "p", kind: "a1_agent_draft_partial", filename: "草稿-2026-11-12-部分完成.md", version: 1 },
    { artifact_version_id: "f", kind: "a1_agent_draft", filename: "草稿-2026-11-13.md", version: 2 },
  ]);
  assert.equal(p.process.length, 1);
  assert.equal(p.process[0]!.latest.artifact_version_id, "f");
});

test("本组最新一版已被后面的追问任务取代：标 replaced，不计入文件数", () => {
  const s = splitTaskFiles([{ artifact_version_id: "x", kind: "agent_report", filename: "意见书.docx", version: 1, is_latest: false, status: "draft" }]);
  assert.equal(s.files[0]!.replaced, true);
  assert.equal(fileCount(s.files), 0);
  assert.equal(fileCount(s.files, "draft"), 0);
});

test("文件类型、主交付物匹配、过程文件命名", () => {
  assert.equal(fileTypeLabel("a.docx"), "Word");
  assert.equal(fileTypeLabel("a.xlsx"), "Excel");
  assert.equal(fileTypeLabel("草稿.md"), "文本");
  assert.ok(isPrimaryFile("尽调报告（内部稿）-栖桐科技增资.docx", "尽调报告（内部稿）.docx"));
  assert.ok(isPrimaryFile("法律意见书-甲公司.docx", "法律意见书（草稿）.docx"));
  assert.ok(!isPrimaryFile("尽调发现表-栖桐科技增资.xlsx", "尽调报告（内部稿）.docx"));
  assert.ok(!isPrimaryFile("x.docx", null));
  assert.equal(fileListName({ kind: "a1_agent_draft", filename: "草稿-2026-11-12.md", title: "已完成审查。收到合同材料 1 份" }), "答复摘要");
  assert.equal(fileListName({ kind: "a1_agent_draft_partial", filename: "草稿.md" }), "答复摘要（部分完成）");
  assert.match(fileListName({ kind: "a1_review_note", filename: "独立复核意见-x.md", title: "独立复核意见：x" }), /^独立复核意见：x/);
  // 名称里的代号照旧经 restore 还原
  assert.equal(artifactName({ kind: "revision_draft", filename: "〔甲〕合同（修订稿）.docx" }, (t) => t.replace("〔甲〕", "禾屿")), "禾屿合同（修订稿）");
});

const step = (title: string, at: string, extra: Partial<Step> = {}): Step => ({ key: title + at, level: "lawyer", icon: "ok", title, at, ...extra });

test("过程收成一行：用时与步数（处理细节不算步数）", () => {
  const steps = [step("阅读材料", "2026-11-12T15:00:10Z"), { ...step("出错代码", "2026-11-12T15:05:00Z"), level: "detail" as const }, step("已完成", "2026-11-12T15:15:58Z")];
  assert.equal(processSummary(steps, "2026-11-12T15:00:10Z"), "处理过程 · 用时 15 分 48 秒 · 2 步");
  assert.equal(processSummary([]), "处理过程 · 0 步");
  assert.equal(durationText(42_000), "42 秒");
  assert.equal(durationText(3_725_000), "1 小时 2 分");
});

test("结束后要露在外面的问题：没完成与只完成一部分的步骤；去掉状态行本身与已自动重试的", () => {
  const steps = [
    step("阅读材料", "t1"),
    step("AI 服务出了点问题，正在自动重试", "t2", { icon: "fail" }),
    step("没有交出《法律意见书》", "t3", { icon: "fail", detail: "助手只交了附件" }),
    step("到工作时限时已交出 2 份文件，收尾没有完成", "t4", { icon: "dot" }),
    { ...step("出错代码", "t5", { icon: "fail" }), level: "detail" as const },
    step("部分完成", "t6", { icon: "dot" }),
  ];
  assert.deepEqual(problemSteps(steps).map((s) => s.title), ["没有交出《法律意见书》", "到工作时限时已交出 2 份文件，收尾没有完成"]);
  // 失败那一步带原因时保留（原因就是要给律师看的说明）
  assert.deepEqual(problemSteps([step("失败", "t", { icon: "fail", detail: "AI 服务连不上" })]).map((s) => s.title), ["AI 服务连不上"]);
  // 读材料、查条文这类工具步骤失败不单列（助手会换个办法接着做）
  assert.deepEqual(problemSteps([step("阅读材料", "t", { icon: "fail" }), step("查看条文原文（3 条）", "t", { icon: "fail" })]), []);
});

test("三处共用一个分组函数；成果页计数按文件；执行页结束后过程收成一行、运行中排法不变", () => {
  const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  const page = read("pages/Deliverables.tsx");
  assert.equal(page.split("splitTaskFiles(").length - 1 >= 2, true, "全局成果页与事项成果页");
  assert.match(page, /\{l\}（\{count\(k\)\}）/, "筛选计数按文件");
  assert.doesNotMatch(page, /rows\.filter\(\(r\) => r\.status === k\)\.length/);
  const rv = read("pages/RunView.tsx");
  assert.match(rv, /currentFiles\(artifacts, \{ primary: primaryName \}\)/);
  assert.match(rv, /const doneLayout = terminal && status !== "reconciling";/);
  assert.match(rv, /processSummary\(allSteps, run\?\.created_at\)/);
  assert.match(rv, /aria-expanded=\{processOpen\}/);
  const row = read("components/ArtifactRow.tsx");
  // 旧版与过程文件不给“提交复核”：只有最新版那一行带 onSubmit
  assert.equal(row.split(">提交复核<").length - 1, 1);
});

test("时间线：复核人回看——都已处理是一条完成步骤；有没落实的是一条未完成步骤，会进顶部“没做完的事”（V18 第 43 批）", async () => {
  const { buildSteps, problemSteps } = await import("../src/lib/timeline.ts");
  const ev = (id: number, type: string, payload: Record<string, unknown>) => ({ event_id: id, seq: id, type, payload, created_at: "2026-11-13T02:00:00.000Z" }) as any;
  const ok = buildSteps([ev(1, "review.followup", { must: 2, done: 1, justified: 1, open: [], unknown: [] })]);
  assert.equal(ok.at(-1)!.title, "复核人回看：必须改的意见都已处理");
  assert.equal(ok.at(-1)!.icon, "ok");
  const open = buildSteps([ev(1, "review.followup", { must: 3, done: 2, justified: 0, open: [3], unknown: [] })]);
  assert.equal(open.at(-1)!.title, "复核人回看：必须改的意见里，第 3 条没有落实到文件");
  assert.equal(open.at(-1)!.icon, "fail");
  assert.ok(problemSteps(open).some((s) => s.title.includes("第 3 条没有落实到文件")));
  const failed = buildSteps([ev(1, "review.followup", { must: 1, failed: true, error: "bad request" })]);
  assert.equal(failed.at(-1)!.level, "detail");
});
