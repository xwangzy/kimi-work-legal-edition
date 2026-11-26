/**
 * 场景内的关键时刻（帧，场景内相对）——画面（scenes/*.tsx）与配乐音效（cues.ts → make-music.mjs）共用这一份。
 * 纯 TS，不依赖 React，Node 也能直接读。
 */
import { FPS } from "./timeline.ts";
const typedEnd = (text: string, start: number, cps: number) => start + Math.ceil((Array.from(text).length / cps) * FPS);

export const TASK = "审查这份股权转让协议，我方为受让方，重点看付款与违约责任";
export const HOME = (() => {
  const T_TYPE = 186;
  const T_TYPED = typedEnd(TASK, T_TYPE, 13);
  const T_HINT = T_TYPED + 14;
  const T_CLICK = T_HINT + 58;
  return { T_TYPE, T_TYPED, T_HINT, T_CLICK, CPS: 13 };
})();
export const START = { C1: 42, C2: 70, C3: 116 };
export const AUTH_SRC = "委托合同第 9 条（人工智能辅助）";
export const CONSENT = (() => {
  const C_KIND = 44;
  const T_SRC = 70;
  const C_REC = 168;
  const T_NOTICE = 180;
  const C_GO = 282;
  const T_PAPER = 292;
  return { C_KIND, T_SRC, T_SRC_END: typedEnd(AUTH_SRC, T_SRC, 14), C_REC, T_NOTICE, C_GO, T_PAPER, SWAPS: [T_PAPER + 72, T_PAPER + 94, T_PAPER + 116, T_PAPER + 138], ITEMS: [T_NOTICE + 22, T_NOTICE + 46, T_NOTICE + 70] };
})();
export const RUNB = { T1: 10, T_ASK: 20, C_PICK: 62, C_OK: 88, T2: 112, T3: 128, T4: 144, T_REVIEW: 150 };
export const RISK = { T_LAND: 74, T_BLOOM: 84, T_PAN: 170, T_WIDE: 300 };
export const CITE = { T_LAW: 40, T_DOWN: 90, T_SPOT: 104 };
export const DECIDE = { C1: 104, T_NEXT: 112, T_PAPER: 150, T_STRIKE: 196, T_INS: 240, T_INS_END: 396 };
export const DELIVER = { T_LIFT: 40 };
export const SIGN = { C_SIGN: 66, T_SIGNED: 80, T_TOP: 124 };
export const PROOF = { L1: 6, L2: 42, L3: 78 };
