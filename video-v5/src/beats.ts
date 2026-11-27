/**
 * 各场内的关键时刻（场景内帧，60 fps）。画面与音效（cues.ts → make-music.mjs）共用这里的数字。
 */
export const CORPUS = {
  MACRO_END: 300, // 微距横移结束（焦点在“秩序”）
  PULL_END: 780, // 后拉结束（星海全景）
  C1: 180, C1_OUT: 470,
  C2: 520, C2_OUT: 960, C3_DELAY: 180, // 第二行“今天，智能开始读懂文字。”随蓝点出现
  DOT_AT: 730, READ_AT: 780, READ_PER: 56,
  FLY_AT: 948, FLY_DUR: 160, WAVE: 930, // 读完三行后，光波从阅读块向整片星海扩散（智能读完一切）
  DIVE_AT: 1140, DIVE_DUR: 160,
  C4: 990, C4_OUT: 1250,
} as const;

/** 第四幕 一镜到底（场景内帧，共 2000）。 */
export const TASK = "审查这份股权转让协议，我方为受让方，重点看付款与违约责任";
export const ONETAKE = {
  T_TITLE: 20, T_TITLE_OUT: 210,
  T_TYPE: 140, CPS: 13,
  T_HINT: 0, // 运行时算：打字结束 + 14
  T_CLICK: 0,
  ST2: 420, C_PICK: 510, C_OK: 562, T_ANSWERED: 640,
  ST3: 710, T_LAND: 770, T_PAN: 850, C_ACCEPT: 980, T_REJ: 1040, T_RED: 1190,
  ST4: 1330, T_DIM: 1452,
  // 说明字（“一句话交代”由开场标题承担，不再单列）
  CAP: [
    [430, 585],
    [790, 960],
    [1005, 1180],
    [1210, 1440],
  ] as [number, number][],
};
{
  const typed = Math.ceil((Array.from(TASK).length / ONETAKE.CPS) * 60);
  (ONETAKE as { T_HINT: number }).T_HINT = ONETAKE.T_TYPE + typed + 14;
  (ONETAKE as { T_CLICK: number }).T_CLICK = ONETAKE.T_HINT + 60;
}

/** 第二幕 痛点（场景内帧，共 1300）。 */
export const NIGHT = {
  D_PULL: 300, PAPERS_AT: 250,
  E_AT: 520, E_JUMP: 600, E_STEP: 30,
  F_AT: 900,
  B1: 150, B1_OUT: 480,
  B2: 580, B2_OUT: 870,
  B3: 960, B3_OUT: 1250,
} as const;

/** 第三幕 三问 → 登场（场景内帧，共 900）。 */
export const TURN = {
  STREAM: 40, CPS: 32, UNDERLINE: 236, LEAD: 250,
  Q1: 280, Q2: 360, Q3: 440,
  FADE: 640, DOT_BLUE: 610, DOT_MOVE: 664, BLOOM: 684, MARK: 726,
} as const;

/** 第三幕 首页（场景内帧，共 500）。 */
export const HOMEB = { SUB: 10, SUB_OUT: 104, MATCH: 112, METHODS: 250, C2: 262, C2_OUT: 430, BACK: 444 } as const;

/** 第五幕 回答（场景内帧，共 1500；第二、三问内部时刻相对各自起点）。 */
export const ANSWERS = { A1: 0, A2: 460, A3: 940, FLOW: 230, REVIEW: 0, C_SIGN: 250, SIGNER: 310, TOP: 440, END: 1480 } as const;

/** 第六幕 晨光与主题（场景内帧，共 800）。 */
export const DAWN = { LAMP_OFF: 170, DAY: 196, PULL: 200, F1: 320, F1_OUT: 530, F2: 580, VERB: 40, F2_OUT: 890, THEME: 940, EN: 1050 } as const;
/** 落版（场景内帧，共 600）。 */
export const FINALE = { THEME_OUT: 200, DOT: 240, MARK: 258, NAME_OUT: 450, STAMP: 495, CROSS: 517, NAMES: 531, TAG: 549, NOTE: 575, FADE: 900 } as const;
