/**
 * 动作提示点（唯一出处）：画面里的点击、打字、出现与配乐/音效共用同一组帧号。
 * 场景内帧号为该场景的局部帧；GLOBAL_CUES 换算为全片帧，供 scripts/make-music.mjs 生成音效。
 * 点击都落在拍点上（1 拍 = 16 帧）。
 */
import { BEAT, SCENES } from "./timeline.ts";

/* S5 首页：打字 → 系统认出“审合同” → 点“使用审合同” */
export const HOME_TASK = "审查这份股权转让协议，我方为受让方，重点关注付款与违约责任";
export const HOME_TYPE_AT = 36;
export const HOME_TYPE_CPS = 15;
export const HOME_SUGGEST = 136;
export const HOME_CLICK = 208;

/* S6 开始审查前：点选重点 → 展开“看看 AI 会看到什么” → 当事人信息逐个换成代号 → 开始审查 */
export const PRIV_CHIPS = [48, 64];
export const PRIV_PREVIEW = 96;
export const PRIV_REDACT = [144, 156, 168, 180];
export const PRIV_START = 240;

/* S7 执行：步骤随节拍完成 */
export const RUN_STEPS = [8, 32, 48, 64, 88, 104, 120];
export const RUN_SUMMARY = 136;

/* S8 引用：三张核对卡依次出现 */
export const CITE_IN = [12, 24, 36];
export const CITE_FLAG = 128;

/* S9 审查工作台 */
export const RV_ACCEPT = 64;
export const RV_REJECT = 160;
export const RV_REDLINE = 240;

/* S10 三条业务线 */
export const UNIFY_LINES = [16, 48, 80];
export const UNIFY_MERGE = 132;

export const SCATTER_APPEAR = Array.from({ length: 12 }, (_, k) => (k < 8 ? 8 + k * BEAT : 8 + 8 * BEAT + (k - 8) * (BEAT / 2)));

const g = (scene: keyof typeof SCENES, f: number) => SCENES[scene].from + f;

export type CueType = "type" | "click" | "whoosh" | "pop" | "blip" | "warn" | "tick";
export const GLOBAL_CUES: { f: number; type: CueType; v?: number }[] = [
  ...SCATTER_APPEAR.map((f, i) => ({ f: g("scatter", f), type: "tick" as const, v: 0.5 + i * 0.03 })),
  ...Array.from(HOME_TASK).map((_, i) => ({ f: g("home", HOME_TYPE_AT + Math.floor((i * 30) / HOME_TYPE_CPS)), type: "type" as const })),
  { f: g("home", HOME_SUGGEST), type: "pop", v: 1 },
  { f: g("home", HOME_CLICK), type: "click" },
  { f: g("privacy", 0) + 2, type: "whoosh", v: 0.35 },
  ...PRIV_CHIPS.map((f) => ({ f: g("privacy", f), type: "click" as const })),
  { f: g("privacy", PRIV_PREVIEW), type: "click" },
  ...PRIV_REDACT.map((f, i) => ({ f: g("privacy", f), type: "pop" as const, v: i })),
  { f: g("privacy", PRIV_START), type: "click" },
  ...RUN_STEPS.map((f, i) => ({ f: g("run", f), type: "blip" as const, v: i % 3 })),
  { f: g("run", RUN_SUMMARY), type: "pop", v: 2 },
  ...CITE_IN.map((f, i) => ({ f: g("cite", f), type: "blip" as const, v: i })),
  { f: g("cite", CITE_FLAG), type: "warn" },
  { f: g("review", RV_ACCEPT), type: "click" },
  { f: g("review", RV_ACCEPT + 8), type: "blip", v: 1 },
  { f: g("review", RV_REJECT), type: "click" },
  { f: g("review", RV_REDLINE), type: "click" },
  { f: g("review", RV_REDLINE + 10), type: "whoosh", v: 0.6 },
  ...UNIFY_LINES.map((f, i) => ({ f: g("unify", f), type: "pop" as const, v: i })),
  { f: g("scatter", 0), type: "whoosh", v: 0.35 },
  { f: g("converge", 20), type: "whoosh", v: 0.8 },
  { f: g("run", 0) - 6, type: "whoosh", v: 0.45 },
  { f: g("cite", 0) - 6, type: "whoosh", v: 0.4 },
  { f: g("review", 0) - 6, type: "whoosh", v: 0.45 },
  { f: g("unify", 0) - 6, type: "whoosh", v: 0.5 },
  { f: g("unify", UNIFY_MERGE), type: "whoosh", v: 0.7 },
  { f: g("trust", 0) - 6, type: "whoosh", v: 0.4 },
];
