/** v9.3 第 15 批 B-4：下载按钮的说法与 Markdown 成果下载成 Word；上传模板与样张经主进程系统对话框（句柄换路径）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { downloadPlan } from "../src/lib/download.ts";

const require = createRequire(import.meta.url);
const { resolveFileParams } = require("../electron/file-dialogs.cjs") as { resolveFileParams: (m: string, p: unknown, s: { take: (h: unknown, kind: string) => string | null }) => any };

test("B-4 下载按钮：Markdown 下载成 Word（文件名改 .docx），Word / Excel / PDF 照原样", () => {
  assert.deepEqual(downloadPlan("研究备忘录.md"), { label: "下载 Word", as: "docx", saveName: "研究备忘录.docx" });
  assert.deepEqual(downloadPlan("意见书.docx"), { label: "下载 Word", as: null, saveName: "意见书.docx" });
  assert.equal(downloadPlan("表.xlsx").label, "下载 Excel");
  assert.equal(downloadPlan("判决.pdf").label, "下载 PDF");
  assert.deepEqual(downloadPlan("说明.txt"), { label: "下载", as: null, saveName: "说明.txt" });
});

test("B-4 上传律所模板、下载样张：主进程把对话框句柄换成内核参数，页面自带的路径一律剥掉", () => {
  const store = { take: (h: unknown, kind: string) => (h === "h1" ? `/Users/x/${kind}.dotx` : null) };
  assert.deepEqual(resolveFileParams("doc_style.set_template", { file_handle: "h1", filename: "模板.dotx", file: "/etc/passwd" }, store).params, { filename: "模板.dotx", file: "/Users/x/open.dotx" });
  assert.deepEqual(resolveFileParams("doc_style.sample", { save_handle: "h1", save_path: "/tmp/x" }, store).params, { save_path: "/Users/x/save.dotx" });
  assert.ok(resolveFileParams("doc_style.set_template", { file_handle: "bad" }, store).error);
});

test("B-5 整理案卷两段：第一段按规则整理（可带已知争点），第二段“争点与证据分析”用 issue-evidence-matrix 方法，完成后接着做", async () => {
  const { SCENARIOS, NEXT_STEPS, splitIssues, buildGoal } = await import("../src/lib/scenarios.ts");
  const casefile = SCENARIOS.find((c) => c.id === "casefile")!;
  const issues = SCENARIOS.find((c) => c.id === "issues")!;
  assert.equal(casefile.scenario, "s2.case_file");
  assert.ok(casefile.gets.some((g) => g.includes("框架")), "不再承诺 AI 对应");
  assert.ok(casefile.steps.some((s) => s.includes("不调用 AI")));
  assert.equal(issues.scenario, "a1.agent_task");
  assert.equal(issues.skill, "issue-evidence-matrix");
  assert.equal(NEXT_STEPS.casefile?.[0], "issues", "整理案卷完成后第一个建议就是第二段");
  assert.ok(!casefile.intents.some((w) => w.length === 1 && w[0] === "争点"), "说“争点”时引到第二段");
  assert.ok(issues.intents.some((w) => w.length === 1 && w[0] === "争点"));
  assert.deepEqual(splitIssues("货款是否付清；违约金是否过高\n违约金是否过高;  "), ["货款是否付清", "违约金是否过高"]);
  assert.equal(buildGoal(issues, { claims: "支付货款 120 万元", side: "原告 / 申请人" }, ""), "请梳理争点与证据：拟主张或需应对的请求为支付货款 120 万元；我方诉讼地位：原告 / 申请人。有我确认过的事实时只用确认的事实；还没有确认的，用材料载明的事实并标【未确认】，评估写“初步判断”。不评估胜诉率。");
});
