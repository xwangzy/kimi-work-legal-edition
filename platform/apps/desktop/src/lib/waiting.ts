/**
 * 统一等待反馈的纯函数（第 51 批；界面见 components/Loading.tsx，样式见 styles-motion.css）。可单测。
 *
 * 原则（第一性原理）：等待反馈要回答律师三个问题——“它在动吗”“在做什么”“要等多久 / 我能做什么”；
 * 不画假进度（不知道总量就不出百分比），不把失败显示成空状态，等得久了在同一处升级说明，而不是换一种样式。
 */

/** 等待的级别：即时（不出加载态）、短（骨架 / 按钮内圆环）、中（蓝点 + 阶段 + 已用时）、长（再加说明与出口）。 */
export type WaitLevel = "instant" | "short" | "medium" | "long";

/** 按已等待的毫秒数定级：0.3 秒内不出加载态（避免一闪），3 秒起给已用时间，30 秒起给“为什么慢 / 能做什么”。 */
export function waitLevel(ms: number): WaitLevel {
  if (ms < 300) return "instant";
  if (ms < 3_000) return "short";
  if (ms < 30_000) return "medium";
  return "long";
}

/** 已用时间：8 秒 / 1 分 12 秒 / 2 分钟（全库一种写法；问答、执行页、导入共用）。 */
export function fmtWait(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} 分钟` : `${m} 分 ${r} 秒`;
}

/** 有总量时的真实进度（“第 3/12 份”）；没有总量返回 null（不画假进度）。 */
export function countProgress(done: number, total: number | null | undefined): { text: string; ratio: number } | null {
  if (!total || total <= 0 || !Number.isFinite(total)) return null;
  const d = Math.max(0, Math.min(Math.floor(done), total));
  return { text: `${d}/${total}`, ratio: d / total };
}

/**
 * 取数三态（加载、失败、成功）：失败不能显示成空状态（审计：数据去向页取数失败曾显示“本事项还没有发出过任何内容”）。
 * 返回界面该显示哪一种。纯函数。
 */
export function loadState<T>(data: T | null | undefined, error: string | null | undefined): "loading" | "error" | "ready" {
  if (error) return "error";
  return data === null || data === undefined ? "loading" : "ready";
}
