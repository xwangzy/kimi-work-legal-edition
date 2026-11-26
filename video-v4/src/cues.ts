/**
 * 全片音效提示点（帧，全片绝对时间）——由 scripts/make-music.mjs 读取。与画面共用 beats.ts 里的关键时刻。
 * type：type（打字）/ click（点击）/ whoosh（转场风声）/ pop（提示亮起）/ blip（状态变化）/ tick（步骤）/ swap（代号替换）/ paper（纸张）
 */
import { AUTH_SRC, CITE, CONSENT, DECIDE, DELIVER, HOME, PROOF, RISK, RUNB, SIGN, START, TASK } from "./beats.ts";
import { FPS, SCENES } from "./timeline.ts";

export interface Cue { f: number; type: string; v?: number }
const at = (k: keyof typeof SCENES, local: number) => SCENES[k].from + local;
const typing = (k: keyof typeof SCENES, start: number, text: string, cps: number): Cue[] =>
  Array.from(text).map((_, i) => ({ f: at(k, start + Math.round((i / cps) * FPS)), type: "type" }));

export const GLOBAL_CUES: Cue[] = [
  // 序幕：纸张掠过、蓝点
  ...[300, 360, 420, 480, 540].map((f, i) => ({ f: at("paper", f), type: "paper", v: 0.6 + (i % 2) * 0.3 })),
  { f: at("paper", 712), type: "pop", v: 1 },
  // 首页
  { f: at("home", 0), type: "whoosh", v: 0.35 },
  ...typing("home", HOME.T_TYPE, TASK, HOME.CPS),
  { f: at("home", HOME.T_HINT), type: "blip", v: 1 },
  { f: at("home", HOME.T_CLICK), type: "click" },
  // 开始面板
  { f: at("start", START.C1), type: "click" },
  { f: at("start", START.C2), type: "click" },
  { f: at("start", START.C3), type: "click" },
  // 授权与代号
  { f: at("consent", CONSENT.C_KIND), type: "click" },
  ...typing("consent", CONSENT.T_SRC, AUTH_SRC, 14),
  { f: at("consent", CONSENT.C_REC), type: "click" },
  ...CONSENT.ITEMS.map((f, i) => ({ f: at("consent", f), type: "pop", v: i })),
  { f: at("consent", CONSENT.C_GO), type: "click" },
  { f: at("consent", CONSENT.T_PAPER - 10), type: "whoosh", v: 0.4 },
  ...CONSENT.SWAPS.map((f, i) => ({ f: at("consent", f), type: "swap", v: i })),
  // 过程
  ...[RUNB.T1, RUNB.T2, RUNB.T3, RUNB.T4].map((f) => ({ f: at("run", f), type: "tick", v: 0.8 })),
  { f: at("run", RUNB.T_ASK), type: "blip", v: 2 },
  { f: at("run", RUNB.C_PICK), type: "click" },
  { f: at("run", RUNB.C_OK), type: "click" },
  { f: at("run", RUNB.T_REVIEW), type: "pop", v: 2 },
  // 审查、引用、判断
  { f: at("risk", RISK.T_LAND), type: "pop", v: 1 },
  { f: at("risk", RISK.T_PAN), type: "whoosh", v: 0.3 },
  { f: at("cite", CITE.T_SPOT), type: "pop", v: 1 },
  { f: at("decide", DECIDE.C1), type: "click" },
  { f: at("decide", DECIDE.T_PAPER), type: "whoosh", v: 0.35 },
  { f: at("decide", DECIDE.T_STRIKE), type: "swap", v: 0 },
  ...Array.from({ length: 12 }).map((_, i) => ({ f: at("decide", DECIDE.T_INS + Math.round(((DECIDE.T_INS_END - DECIDE.T_INS) * i) / 12)), type: "type" })),
  // 交付与签发
  { f: at("signoff", SIGN.C_SIGN), type: "click" },
  { f: at("signoff", SIGN.T_SIGNED + 8), type: "pop", v: 3 },
  { f: at("deliver", DELIVER.T_LIFT + 6), type: "paper", v: 1.3 },
  ...[PROOF.L1, PROOF.L2].map((f, i) => ({ f: at("proof", f), type: "blip", v: i })),
  // 一个工作空间、保密
  { f: at("breadth", 120), type: "whoosh", v: 0.45 },
  { f: at("partner", 62), type: "stamp", v: 1 },
  { f: at("trust", 0), type: "whoosh", v: 0.3 },
  ...[70, 104, 138].map((f, i) => ({ f: at("trust", f), type: "tick", v: 0.6 + i * 0.1 })),
];
