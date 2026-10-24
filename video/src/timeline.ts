/**
 * 全片时间轴（唯一出处）：30 fps，112.5 BPM → 1 拍 = 16 帧，1 小节 = 64 帧。
 * 场景切点全部落在小节或半小节上，配乐脚本 scripts/make-music.mjs 读取同一份数据生成节拍对齐的配乐与音效。
 */
export const FPS = 30;
export const BEAT = 16;
export const BAR = 64;
export const WIDTH = 1920;
export const HEIGHT = 1080;

/** 场景：from / dur 单位为帧。 */
export const SCENES = {
  weight: { from: 0, dur: 224 }, // S1 一页页文字的分量
  scatter: { from: 224, dur: 192 }, // S2 在工具之间不断切换
  converge: { from: 416, dur: 96 }, // S3 汇于一处
  reveal: { from: 512, dur: 128 }, // S4 产品登场
  home: { from: 640, dur: 256 }, // S5 一句话交代任务，系统认出这是“审合同”
  privacy: { from: 896, dur: 256 }, // S6 开始审查前：选重点、看 AI 会看到什么——当事人信息先换成代号
  run: { from: 1152, dur: 192 }, // S7 每一步都看得见
  cite: { from: 1344, dur: 192 }, // S8 引用核验
  review: { from: 1536, dur: 320 }, // S9 AI 提出意见，律师作出判断
  unify: { from: 1856, dur: 256 }, // S10 三条业务线，一个工作空间
  trust: { from: 2112, dur: 192 }, // S11 可信
  theme: { from: 2304, dur: 192 }, // S12 主题
  lockup: { from: 2496, dur: 128 }, // S13 产品名
  partner: { from: 2624, dur: 256 }, // S14 联袂打造（含 1 小节尾声）
} as const;

export const DURATION = SCENES.partner.from + SCENES.partner.dur; // 2880 帧 = 96 秒

export type SceneKey = keyof typeof SCENES;
