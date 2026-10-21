/**
 * 执行态的过程信息（Kimi Code 增量核查 K7-P）：把内核交来的过程快照变成律师看得懂的几行字。纯函数，可单测。
 * 文字是令牌形态，由调用方渲染时还原代号。
 */
import type { RunProgress } from "../api.ts";

export interface ProgressViewModel {
  /** 模型重试中（取代“正在处理…”的说明）。 */
  retry: string | null;
  /** 第几次重试（界面据此在第 3 次起显示“停止，稍后再试”）。 */
  retryAttempt?: number;
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
    // v9.4（U1 §3.5 #9）：短句；第 3 次起界面另给“停止，稍后再试”按钮（retryStoppable）
    vm.retry = `AI 服务暂时没有回应，正在重试${of}。已完成的部分不会丢。`;
    vm.retryAttempt = p.retry.attempt;
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
/** 过程面板有没有内容可放（v9.4：重试提示只在时间线里显示，不再单独撑起一个空面板——U1 截图 u1-46 的“空白长条”）。 */
export function hasProgress(vm: ProgressViewModel): boolean {
  return Boolean(vm.todo || vm.subagents || vm.tasks || vm.notes.length || vm.compaction);
}

/** 重试到第 3 次起，给律师一个“停止，稍后再试”的出口。纯函数。 */
export function retryStoppable(vm: ProgressViewModel): boolean {
  return !!vm.retry && (vm.retryAttempt ?? 0) >= 3;
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
  if (!p) return "";
  // 心跳单独计（engineHeartbeatMs）：它表示“引擎还活着”，不等于“有了律师能看到的新进展”
  const { activity, ...rest } = p;
  return JSON.stringify({ ...rest, phase: activity?.phase ?? null, since: activity?.since ?? null, tool: activity?.tool ?? null });
}

/**
 * 合并一次轮询得到的过程快照（复核 S6B-01）：内容不变时保留原对象（避免每秒重渲染），但心跳一律取新快照的——
 * 曾经连心跳一起丢掉，长时间思考时看门狗读到的永远是旧心跳。
 */
export function mergeProgress(prev: RunProgress | null, next: RunProgress | null): { progress: RunProgress | null; heartbeatMs: number } {
  return { progress: progressActivityKey(prev) === progressActivityKey(next) ? prev : next, heartbeatMs: engineHeartbeatMs(next) };
}

/**
 * 何时提示“已经有一阵子没有新进展”（复核 S6B-03）：一般 90 秒；正在执行工具（运行代码、读大文件）时工具本身不发事件，
 * 而执行域另有硬时限，放宽到 10 分钟，期间显示阶段行与已用时间。
 */
export function stallThresholdMs(p: RunProgress | null | undefined): number {
  return p?.activity?.phase === "tool" ? 600_000 : 90_000;
}

/** 静默时长：界面进展与引擎心跳中较新者到现在的间隔。 */
export function silenceMs(now: number, lastActivity: number, heartbeatMs: number): number {
  return now - Math.max(lastActivity, heartbeatMs);
}

/** 引擎最近一次心跳的时刻（毫秒）；没有心跳返回 0。 */
export function engineHeartbeatMs(p: RunProgress | null | undefined): number {
  const t = p?.activity?.heartbeat_at ? Date.parse(p.activity.heartbeat_at) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function elapsedText(ms: number): string {
  const sec = Math.floor(ms / 1000);
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, "0")} 秒`;
}

/**
 * 阶段行（UIUX 增量评审 P0-D）：取代笼统的“正在处理…”。同一阶段超过 30 秒时带上已用时间，让律师知道它还在做、做了多久。
 * 重试另有提示（progressView.retry），这里返回 null；没有阶段信息（旧内核）也返回 null。
 */
export function phaseLine(p: RunProgress | null | undefined, now: number, label: (tool: string) => string): string | null {
  const a = p?.activity;
  if (!a?.phase || a.phase === "retrying") return null;
  // 没登记律师用语的工具不显示英文原名（复核 S6B-10）
  const named = a.tool ? label(a.tool) : "";
  const what = a.phase === "thinking" ? "正在思考下一步" : a.phase === "writing" ? "正在写" : `正在执行：${named && !/^[\x00-\x7f]+$/.test(named) ? named : "一个步骤"}`;
  const since = a.since ? Date.parse(a.since) : NaN;
  return Number.isFinite(since) && now - since >= 30_000 ? `${what}（已 ${elapsedText(now - since)}）` : `${what}…`;
}
