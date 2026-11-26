/**
 * 30 秒社媒版剪辑表：从正片各场截取片段（场景内帧区间），按 100 BPM 的小节首尾相接，共 1800 帧（12.5 小节）。
 * 画面（Cut30.tsx）与配乐（make-music.mjs，SCORE=cut30）共用这一份。
 */
import { GLOBAL_CUES } from "./cues.ts";
import { SCENES, type SceneKey } from "./timeline.ts";

export interface Seg { scene: SceneKey; from: number; to: number }
export const CUT30: Seg[] = [
  { scene: "paper", from: 650, to: 854 }, // 钩子：夜色里的协议 + “让 AI 承担繁杂，让律师专注于专业判断。” → 蓝点
  { scene: "reveal", from: 36, to: 180 }, // 蓝点 → 标识 → Kimi Work 法律版
  { scene: "home", from: 190, to: 432 }, // 一句话交代任务，认出“审合同”
  { scene: "consent", from: 296, to: 504 }, // 发出前换成代号（停住）
  { scene: "proof", from: 0, to: 120 }, // 17 项审查意见 · 8 项重大风险
  { scene: "decide", from: 40, to: 330 }, // AI 提出意见，律师作出判断 → 修订写在纸上
  { scene: "signoff", from: 40, to: 120 }, // 确认签发 → 签发人 → 已签发（末尾浸入夜色）
  { scene: "theme", from: 56, to: 216 }, // 让法律专业能力，进入 AI 时代。 / Legal Intelligence. Reimagined.（完整停住）
  { scene: "lockup", from: 0, to: 50 }, // 暖白从蓝点展开（与正片同一转场）
  { scene: "partner", from: 0, to: 302 }, // 中软国际 × Kimi 联袂打造（停住）
];
export const CUT30_STARTS = CUT30.reduce<number[]>((a, s, i) => (a.push(i === 0 ? 0 : a[i - 1] + (CUT30[i - 1].to - CUT30[i - 1].from)), a), []);
export const CUT30_DURATION = CUT30.reduce((n, s) => n + (s.to - s.from), 0);
/** 正片的音效提示点映射到剪辑时间轴。 */
export const CUT30_CUES = CUT30.flatMap((seg, i) => {
  const base = SCENES[seg.scene].from;
  return GLOBAL_CUES.filter((c) => c.f >= base + seg.from && c.f < base + seg.to).map((c) => ({ ...c, f: CUT30_STARTS[i] + (c.f - base - seg.from) }));
});
