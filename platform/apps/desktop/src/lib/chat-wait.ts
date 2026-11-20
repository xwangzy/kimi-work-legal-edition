/**
 * 问答等待状态的文案（第 48 批；纯函数，界面只管显示）。
 *
 * 背景：推理型模型在“深度思考”时先静默想 1～3 分钟才出第一个字（实测 K3.1-Pro 首字约 194 秒、全文约 208 秒）；
 * 光把正文改成流式只省得了最后十几秒。所以：① 默认“快速回答”；② 深度思考时把“正在想、已想多久”说清楚。
 *
 * 开关实际控制什么因模型而异（第 49 批，按 Kimi 官方参数表与真实请求核对）：
 * - K3 系列（control = "effort"）始终思考、不支持关闭思考：快速 = 推理强度 low（仍会简短思考，实测首字约 4～6 秒，难题约 45 秒），
 *   深度 = max。所以快速档收到思考进度时如实显示“简短思考中”，不假装“没在思考”；
 * - K2.6（control = "toggle"）：快速 = 关闭思考（直接作答），深度 = 开启思考。
 *
 * 阶段（来自内核的 chat.progress 与 chat.delta）：
 * - waiting：刚发出，还没收到任何进度；
 * - thinking：模型在思考（带已收到的思考字数，只作“还在动”的信号，不显示思考内容）；
 * - writing：已经在写正文（界面显示逐字出现的回答）。
 */

export type ChatPhase = "waiting" | "thinking" | "writing";

/** 1 分 12 秒 / 8 秒（不足 1 秒按 0 秒，负数按 0）。 */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} 分钟` : `${m} 分 ${r} 秒`;
}

/** 3,200 字（千分位；整数向下取整）。 */
export function fmtChars(n: number): string {
  return `${Math.max(0, Math.floor(n)).toLocaleString("en-US")} 字`;
}

export interface ChatWaitView {
  /** 状态行的主文字。 */
  title: string;
  /** 下面一行补充（可空）。 */
  hint: string | null;
  /** 是否显示不定长进度条（写正文时不显示，回答本身就是进度）。 */
  bar: boolean;
}

/** 深度思考超过这么久还没出字，提示“这个问题想得比较久”。 */
const LONG_THINK_MS = 180_000;
/** 快速回答超过这么久还没出字，提示“比平时慢”。 */
const SLOW_FAST_MS = 25_000;
/** 刚发出这么久内先只说“深度思考通常要 1～3 分钟”，之后改说“已思考多久”。 */
const INTRO_MS = 15_000;

export function chatWaitView(o: { deep: boolean; phase: ChatPhase; elapsedMs: number; thoughtChars: number; control?: ThinkingControl | undefined }): ChatWaitView {
  if (o.phase === "writing") return { title: "正在撰写回答…", hint: null, bar: false };
  if (!o.deep) {
    // K3 快速档 = 推理强度 low，仍会思考：2026-11-20 实测简单问题首字约 5 秒，难题约 1～1.5 分钟（K2.6 关思考约 1～2 秒）
    const slow = o.control === "effort" ? "K3 始终会先思考，难题在快速档也要一分钟左右；要几秒内出答案，可改选 K2.6（快速档不思考）" : "这次比平时慢一些，请再稍等片刻";
    return {
      // 快速档也可能在思考（K3 始终思考，快速只是推理强度低）：收到思考进度就如实说
      title: o.phase === "thinking" ? "简短思考中…" : "正在回答…",
      hint: o.elapsedMs >= SLOW_FAST_MS ? slow : null,
      bar: true,
    };
  }
  // 深度思考
  if (o.elapsedMs < INTRO_MS) return { title: "正在深度思考…", hint: "深度思考通常需要 1～3 分钟，想得越充分，回答越周全", bar: true };
  const done = o.thoughtChars > 0 ? `（思考量约 ${fmtChars(o.thoughtChars)}）` : "";
  if (o.elapsedMs >= LONG_THINK_MS) return { title: "正在深度思考…", hint: `这个问题想得比较久，已思考 ${fmtElapsed(o.elapsedMs)}${done}，请再稍等；下次也可以选“快速回答”`, bar: true };
  return { title: "正在深度思考…", hint: `已思考 ${fmtElapsed(o.elapsedMs)}${done}；想要更快，可下次选“快速回答”`, bar: true };
}

/** 模型的思考控制方式（与内核 QaModelChoice.thinking 同义；旧内核没给时按 undefined）。 */
export type ThinkingControl = "effort" | "toggle" | "none";

/**
 * 发送区“深度思考”开关的提示文字：按所选模型如实说开关控制的是什么（第 49 批）。
 * control 未知（旧内核）时用不区分模型的说法。
 */
export function deepToggleTitle(on: boolean, control?: ThinkingControl, model?: string): string {
  const m = model ?? "模型";
  if (control === "effort") {
    return on
      ? `深度思考：${m} 用最高推理强度（max），复杂问题更周全，可能要 1～3 分钟。点一下改为快速`
      : `快速：${m} 始终会先思考，快速档只是想得少（推理强度 low），通常几秒到几十秒。点一下改为深度思考`;
  }
  if (control === "toggle") {
    return on ? `深度思考：${m} 先思考再回答，更周全，要多等一会儿。点一下改为快速（不思考）` : `快速：${m} 不思考、直接回答，通常几秒。点一下开启深度思考`;
  }
  return on ? "深度思考：先充分思考再回答，更周全，常要 1～3 分钟。点一下改为快速回答" : "快速回答：少思考或不思考，直接作答。点一下改为深度思考（更周全，常要 1～3 分钟）";
}
