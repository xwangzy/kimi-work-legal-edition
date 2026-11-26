/**
 * V4 全片时间轴（唯一出处）：60 fps，100 BPM → 1 拍 = 36 帧（0.6 秒），1 小节 = 144 帧（2.4 秒）。
 * 场景切点全部落在小节（或半小节）上；配乐脚本 scripts/make-music.mjs 读取同一份数据生成节拍对齐的配乐与音效。
 */
export const FPS = 60;
export const BEAT = 36;
export const BAR = 144;
export const WIDTH = 1920;
export const HEIGHT = 1080;

/** 秒 → 帧。 */
export const s = (sec: number) => Math.round(sec * FPS);
const bars = (b: number) => Math.round(b * BAR);

/** 场景：小节起止（含半小节）。 */
const BARS = {
  paper: [0, 6], // 序幕：第 7.1 条微距 → 纸的纵深 → 命题 → 蓝点
  reveal: [6, 8.5], // 蓝点 → Kimi 标识 → 产品名 → 匹配剪辑到首页字标
  // 乐章一 · 交代
  home: [8.5, 11.5], // 首页围绕字标生长成形；一句话交代任务；认出“审合同”
  start: [11.5, 12.5], // 开始面板（动作段，无字）
  consent: [12.5, 16], // 客户授权 → 开始用 AI 之前 → 发出前换成代号（停够）
  // 乐章二 · 过程
  run: [16, 18], // 停下来问律师 + 独立复核
  risk: [18, 21], // 英雄镜头：蓝点落在第 7.1 条上 → 风险标在条款上
  proof: [21, 22], // 证据镜头：17 项审查意见 · 8 项重大风险
  cite: [22, 23.5], // 引用对照法规原文
  // 乐章三 · 判断
  decide: [23.5, 27], // 律师接受 → 第 7.1 条的修订在纸上写出来（英雄镜头）
  signoff: [27, 28.5], // 我已实质复核 → 确认签发 → 已签发
  deliver: [28.5, 31], // 签发后的修订稿从屏幕里抬起，变回一页纸
  // 价值与收束
  breadth: [31, 34], // 一个工作空间：方法库、起诉状、时间轴、问答
  trust: [34, 37], // 为律所的保密义务而设计（夜色）
  value: [37, 39], // AI 不是替代律师，而是延伸律师的专业能力
  theme: [39, 41.5], // 主题句
  lockup: [41.5, 43.5], // 产品名（落点对准小节线）
  partner: [43.5, 47.5], // 中软国际 × Kimi 联袂打造
} as const;

export type SceneKey = keyof typeof BARS;
export const SCENES = Object.fromEntries(Object.entries(BARS).map(([k, [a, b]]) => [k, { from: bars(a), dur: bars(b) - bars(a) }])) as Record<SceneKey, { from: number; dur: number }>;
export const SCENE_BAR = Object.fromEntries(Object.entries(BARS).map(([k, [a]]) => [k, a])) as Record<SceneKey, number>;
export const DURATION = bars(47.5); // 6840 帧 = 114 秒
