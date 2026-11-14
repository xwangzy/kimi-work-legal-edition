/**
 * 第 44 批真实验收（催款律师函任务）：重新运行后任务页“本次交付的文件”里两张核对表并列——上一次运行按 10 日算的《依据与发送前核对-催款》
 * 与这一次按送达后 7 日算的《依据与发送前核对-货款催收》，律师分不清用哪张。
 * 内核现在在 Agent 从头重跑时把上一次的草稿成果标成 superseded；界面把它们收进“上一次运行的文件”，不算交付文件、不给提交复核。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryPackage, fileCount, isEarlierRun, PACKAGE_REASON_TEXT, splitTaskFiles } from "../src/lib/deliverables.ts";
import { artifactOptionOrder, currentFiles } from "../src/lib/run-pane.ts";
import { buildSteps, problemSteps } from "../src/lib/timeline.ts";

let n = 0;
const row = (kind: string, filename: string, version: number, status: string, is_latest = true, minute = 10 + version) => ({
  artifact_version_id: `r${++n}`,
  kind,
  filename,
  version,
  kind_version: version,
  is_latest,
  audience: "internal",
  status,
  created_at: `2026-11-14T05:${String(minute).padStart(2, "0")}:00Z`,
});

// 任务 run_d3687fe9 的成果（文件名取自真实验收）：第一次运行只出了核对表就被额度拦下；重新运行出了核对表、律师函、答复摘要与复核意见
const oldTable = row("agent_table", "依据与发送前核对-催款.xlsx", 1, "superseded", true, 1);
const newTable = row("agent_table", "依据与发送前核对-货款催收.xlsx", 2, "draft");
const letter = row("agent_report", "律师函（草稿）.docx", 1, "draft");
const reply = row("a1_agent_draft", "草稿-2026-11-14.md", 1, "draft");
const note = row("a1_review_note", "独立复核意见-律师函（草稿）.md", 1, "draft");
const rows = [oldTable, newTable, letter, reply, note];

test("重新运行前那一次的核对表：不进本次交付的文件，收进“上一次运行的文件”；计数只算这一次的", () => {
  const s = splitTaskFiles(rows, { primary: "律师函或催告函（草稿）.docx" });
  assert.deepEqual(s.files.map((e) => e.latest.filename), ["律师函（草稿）.docx", "依据与发送前核对-货款催收.xlsx"]);
  assert.deepEqual(s.earlier.map((e) => e.latest.filename), ["依据与发送前核对-催款.xlsx"]);
  assert.ok(s.earlier.every((e) => e.earlier));
  assert.deepEqual(s.process.map((e) => e.latest.kind), ["a1_agent_draft", "a1_review_note"]);
  assert.equal(fileCount(s.files), 2);
  const c = currentFiles(rows, { primary: "律师函或催告函（草稿）.docx" });
  assert.deepEqual(c.current.map((a) => a.filename), ["律师函（草稿）.docx", "依据与发送前核对-货款催收.xlsx"]);
  assert.deepEqual(c.earlier.map((a) => a.filename), ["依据与发送前核对-催款.xlsx"]);
  assert.equal(c.older, 0);
  // 右栏下拉：这一次的文件在前，上一次运行的排在最后（不给“提交复核”：group 不是 file）
  const o = artifactOptionOrder(rows, { primary: "律师函或催告函（草稿）.docx" });
  assert.deepEqual(o.map((x) => [x.row.filename, x.group]), [
    ["律师函（草稿）.docx", "file"],
    ["依据与发送前核对-货款催收.xlsx", "file"],
    ["草稿-2026-11-14.md", "process"],
    ["独立复核意见-律师函（草稿）.md", "process"],
    ["依据与发送前核对-催款.xlsx", "earlier"],
  ]);
});

test("同名文件这一次又出了：上一次那版进旧版，最新版是这一次的；这一次没再出的答复摘要不当本次答复", () => {
  const oldLetter = row("agent_report", "律师函（草稿）.docx", 1, "superseded", false, 1);
  const newLetter = row("agent_report", "律师函（草稿）.docx", 2, "draft", true);
  const oldReply = row("a1_agent_draft", "草稿-2026-11-14.md", 1, "superseded", true, 2);
  const s = splitTaskFiles([oldLetter, newLetter, oldReply]);
  assert.equal(s.files.length, 1);
  assert.equal(s.files[0]!.latest, newLetter);
  assert.deepEqual(s.files[0]!.older, [oldLetter]);
  assert.equal(s.files[0]!.replaced, false);
  // 这一次失败、没出答复：上一次的答复摘要不在过程文件里（任务页不拿它当“结论”）
  assert.deepEqual(s.process, []);
  assert.deepEqual(s.earlier.map((e) => e.latest), [oldReply]);
  const c = currentFiles([oldLetter, newLetter, oldReply]);
  assert.equal(c.older, 1);
  assert.deepEqual(c.process, []);
  // 被取代的那版即使内核说它是同名文件的最新版（这一次没出同名的），也不当最新
  const lone = row("agent_report", "催款函（草稿）.docx", 3, "superseded", true);
  assert.equal(splitTaskFiles([lone]).files.length, 0);
  assert.equal(isEarlierRun(lone), true);
  assert.equal(isEarlierRun(newLetter), false);
});

test("交付包：上一次运行的文件不随包，原因写清是重新运行取代的", () => {
  const signed = { ...row("agent_report", "律师函（客户版）.docx", 1, "approved"), audience: "client" };
  const p = deliveryPackage([{ ...oldTable, version: 1 }, signed]);
  assert.deepEqual(p.ready.map((r) => r.artifact_version_id), [signed.artifact_version_id]);
  assert.deepEqual(p.held.map((h) => [h.row.artifact_version_id, h.reason]), [[oldTable.artifact_version_id, "earlier_run"]]);
  assert.match(PACKAGE_REASON_TEXT.earlier_run, /重新运行/);
});

test("时间线：重新运行那一行说清上一次的文件收起、旧论点不再沿用；不算“没做完的地方”", () => {
  const ev = (type: string, payload: Record<string, unknown>, id: number) => ({ event_id: id, seq: id, type, payload, created_at: "2026-11-14T05:20:00.000Z" }) as any;
  const steps = buildSteps([
    ev("run.started", {}, 1),
    ev("run.earlier_superseded", { files: ["依据与发送前核对-催款.xlsx"], count: 1, kept: [], outlines: 1 }, 2),
    ev("agent.task_started", { agent_task_id: "t", attempt_id: "a2" }, 3),
  ]);
  const s = steps.find((x) => x.title === "重新运行：按这一次的回答和计划重新做");
  assert.ok(s, JSON.stringify(steps.map((x) => x.title)));
  assert.equal(s.level, "lawyer");
  assert.match(String(s.detail), /上一次运行的 1 份文件收进“上一次运行的文件”，不算这次的成果/);
  assert.match(String(s.detail), /论点与依据不再沿用/);
  assert.ok(!problemSteps(steps).includes(s));
  const kept = buildSteps([ev("run.earlier_superseded", { files: [], count: 0, kept: [{ filename: "x.docx", status: "approved" }], outlines: 0 }, 9)]);
  assert.match(String(kept[0]?.detail), /你已提交复核或签发的 1 份保留不动/);
});
