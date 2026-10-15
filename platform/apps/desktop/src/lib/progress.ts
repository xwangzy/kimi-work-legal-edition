/**
 * 执行态的过程信息（Kimi Code 增量核查 K7-P）：把内核交来的过程快照变成律师看得懂的几行字。纯函数，可单测。
 * 文字是令牌形态，由调用方渲染时还原代号。
 */
import type { RunProgress } from "../api.ts";

export interface ProgressViewModel {
  /** 模型重试中（取代“正在处理…”的说明）。 */
  retry: string | null;
  todo: { title: string; done: number; total: number; items: { mark: string; text: string; state: "done" | "doing" | "todo" }[] } | null;
  subagents: { title: string; items: { text: string; state: string; summary: string | null; failed: boolean }[] } | null;
  tasks: { title: string; items: string[] } | null;
  /** 进展通知（最近 5 条，Markdown 文字；source 为“助手”或“子任务”）。 */
  notes: { text: string; source: string }[];
  compaction: string | null;
}

const SUB_STATE: Record<string, string> = { running: "进行中", done: "已完成", failed: "没有完成", cancelled: "已停止", paused: "暂停" };

export function progressView(p: RunProgress | null | undefined): ProgressViewModel {
  const empty: ProgressViewModel = { retry: null, todo: null, subagents: null, tasks: null, notes: [], compaction: null };
  if (!p) return empty;
  const vm = { ...empty };
  if (p.retry) {
    const of = p.retry.max > 0 ? `（第 ${p.retry.attempt}/${p.retry.max} 次）` : "";
    vm.retry = `模型服务暂时没有响应，正在自动重试${of}…已完成的步骤不会丢失；如长时间没有进展，可以取消后稍后重新运行。`;
  }
  if (p.todo.length > 0) {
    const done = p.todo.filter((t) => t.status === "done").length;
    vm.todo = {
      title: `助手的工作清单（${done}/${p.todo.length}）`,
      done,
      total: p.todo.length,
      items: p.todo.map((t) => ({ mark: t.status === "done" ? "✓" : t.status === "in_progress" ? "●" : "○", text: t.title, state: t.status === "done" ? "done" : t.status === "in_progress" ? "doing" : "todo" })),
    };
  }
  if (p.subagents.length > 0) {
    const running = p.subagents.filter((s) => s.status === "running").length;
    const swarm = p.subagents.some((s) => s.swarm_index !== null);
    vm.subagents = {
      title: running > 0 ? (swarm ? `同时进行 ${running} 项核对` : `子任务进行中（${running}）`) : `子任务（${p.subagents.length} 项，已结束）`,
      items: p.subagents.map((s) => ({
        text: s.description || s.name || "子任务",
        state: SUB_STATE[s.status] ?? s.status,
        summary: s.status === "done" ? s.summary : null,
        failed: s.status === "failed",
      })),
    };
  }
  const bg = p.tasks.filter((t) => t.status === "running");
  if (bg.length > 0) vm.tasks = { title: `后台运行中（${bg.length}）`, items: bg.map((t) => t.description || (t.kind === "bash" ? "本机计算" : "后台任务")) };
  vm.notes = p.notes.slice(-5).map((n) => ({ text: n.text, source: n.agent_id && n.agent_id !== "main" ? "子任务" : "助手" }));
  if (p.compaction.blocked) vm.compaction = "对话较长，助手先把前面的内容整理成摘要，整理完自动继续…";
  else if (p.compaction.running) vm.compaction = "对话较长，助手正在把前面的内容整理成摘要…";
  else if (p.compaction.count > 0) vm.compaction = `对话较长，助手已把前面的内容整理成摘要继续工作（第 ${p.compaction.count} 次）。材料原文仍在，结论请以引用的原文为准。`;
  return vm;
}

/** 有没有值得显示的过程信息（空快照不渲染面板）。 */
export function hasProgress(vm: ProgressViewModel): boolean {
  return Boolean(vm.retry || vm.todo || vm.subagents || vm.tasks || vm.notes.length || vm.compaction);
}

/** 过程快照里需要还原代号的文字（面板渲染的每一段模型文字都必须在其中——复核 B4-B03 用例核对）。 */
export function progressTexts(p: RunProgress | null | undefined): string[] {
  if (!p) return [];
  return [
    ...p.todo.map((t) => t.title),
    ...p.subagents.flatMap((x) => [x.description, x.name, x.summary ?? ""]),
    ...p.tasks.map((t) => t.description),
    ...p.notes.map((n) => n.text),
  ];
}

/**
 * 过程快照的“活动键”（复核 B4-B20）：内容相同的两份快照得到相同的键。界面每秒轮询都会反序列化出新对象，
 * 静默看门狗按引用判断“有进展”会被每秒重置；按内容取键才只在过程真的变化时计为活动。
 */
export function progressActivityKey(p: RunProgress | null | undefined): string {
  return p ? JSON.stringify(p) : "";
}
