/** 执行态过程信息的律师文案（K7-P，apps/desktop/src/lib/progress.ts）：空快照不显示；重试、清单、子任务、后台任务、整理各有一行说明。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasProgress, progressView } from "../src/lib/progress.ts";

const base = { todo: [], subagents: [], tasks: [], notes: [], compaction: { count: 0, running: false, blocked: false, last_at: null, tokens_before: null, tokens_after: null }, skills: [], retry: null };

test("K7-P 过程信息：空快照不渲染；重试取代“正在处理…”；清单计数；集群与失败子任务；后台任务；上下文整理", () => {
  assert.equal(hasProgress(progressView(null)), false);
  assert.equal(hasProgress(progressView(base as any)), false);
  const vm = progressView({
    ...base,
    retry: { attempt: 2, max: 5, status_code: 503, at: "2026-10-14T00:00:00.000Z" },
    todo: [{ title: "读合同", status: "done" }, { title: "列风险", status: "in_progress" }, { title: "写意见", status: "pending" }],
    subagents: [
      { id: "a", name: "coder", description: "核对第七条", status: "done", swarm_index: 0, background: false, summary: "无异常" },
      { id: "b", name: "coder", description: "核对第八条", status: "running", swarm_index: 1, background: false, summary: null },
      { id: "c", name: "coder", description: "核对第九条", status: "failed", swarm_index: 2, background: false, summary: "超时" },
    ],
    tasks: [{ id: "t", kind: "bash", description: "", status: "running" }],
    compaction: { count: 2, running: false, blocked: false, last_at: null, tokens_before: 1, tokens_after: 1 },
  } as any);
  assert.ok(hasProgress(vm));
  assert.match(vm.retry!, /正在自动重试（第 2\/5 次）/);
  assert.equal(vm.todo!.title, "助手的工作清单（1/3）");
  assert.deepEqual(vm.todo!.items.map((x) => x.mark), ["✓", "●", "○"]);
  assert.equal(vm.subagents!.title, "同时进行 1 项核对");
  assert.deepEqual(vm.subagents!.items.map((x) => [x.state, x.failed, x.summary]), [["已完成", false, "无异常"], ["进行中", false, null], ["没有完成", true, null]]);
  assert.deepEqual(vm.tasks, { title: "后台运行中（1）", items: ["本机计算"] });
  assert.match(vm.compaction!, /第 2 次/);
  assert.match(progressView({ ...base, compaction: { ...base.compaction, blocked: true } } as any).compaction!, /整理完自动继续/);
});

test("复核 B4-B03 过程面板里渲染的每一段模型文字都在“需要还原代号”的清单里（后台任务描述此前未还原）", async () => {
  const { progressTexts } = await import("../src/lib/progress.ts");
  const p = {
    ...base,
    todo: [{ title: "读〔自然人·ABC123〕的合同", status: "in_progress" }],
    subagents: [
      { id: "a", name: "coder", description: "核对〔机构·XYZ789〕条款", status: "done", swarm_index: null, background: false, summary: "〔自然人·ABC123〕无异常" },
      { id: "b", name: "〔机构·XYZ789〕核对员", description: "", status: "running", swarm_index: null, background: false, summary: null },
    ],
    tasks: [{ id: "t", kind: "bash", description: "导出〔自然人·ABC123〕的流水", status: "running" }],
    notes: [{ at: "2026-10-14T00:00:00.000Z", text: "已读完〔机构·XYZ789〕的材料", agent_id: "main" }],
  } as any;
  const vm = progressView(p);
  const rendered = [
    ...(vm.todo?.items.map((x) => x.text) ?? []),
    ...(vm.subagents?.items.flatMap((x) => [x.text, x.summary ?? ""]) ?? []),
    ...(vm.tasks?.items ?? []),
    ...vm.notes.map((n) => n.text),
  ].filter((t) => t.includes("〔"));
  const restorable = new Set(progressTexts(p));
  assert.ok(rendered.length >= 6, JSON.stringify(rendered));
  for (const t of rendered) assert.ok(restorable.has(t), `面板渲染的“${t}”不在还原清单里`);
  assert.deepEqual(vm.tasks?.items, ["导出〔自然人·ABC123〕的流水"]);
});

test("复核 B4-B20 静默看门狗的活动键按内容：每秒轮询反序列化出的新对象（内容相同）键相同；内容变化键才变", async () => {
  const { progressActivityKey } = await import("../src/lib/progress.ts");
  const a = { ...base, todo: [{ title: "读合同", status: "in_progress" }] } as any;
  const polled = JSON.parse(JSON.stringify(a));
  assert.notEqual(polled, a);
  assert.equal(progressActivityKey(polled), progressActivityKey(a), "内容相同的两份快照得到相同的键");
  assert.notEqual(progressActivityKey({ ...a, todo: [{ title: "读合同", status: "done" }] }), progressActivityKey(a));
  assert.equal(progressActivityKey(null), "");
  assert.equal(progressActivityKey(undefined), "");
});
