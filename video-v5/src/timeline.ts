/**
 * V5 全片时间轴（唯一出处）：60 fps，72 BPM → 1 拍 = 50 帧（0.833 秒），1 小节 = 200 帧（3.333 秒）。
 * 场景切点落在小节或半小节上；配乐脚本 scripts/make-music.mjs 读取同一份数据生成对齐的配乐与音效。
 * 六幕：时代 / 痛点 / 登场 / 一件事 / 回答 / 升华。
 */
export const FPS = 60;
export const BEAT = 50;
export const BAR = 200;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const s = (sec: number) => Math.round(sec * FPS);
const bars = (b: number) => Math.round(b * BAR);

const BARS = {
  corpus: [0, 6.5], // 第一幕 时代：法条微距 → 星海 → 蓝点阅读、光波 → 一个问题 → 潜入“违约金”
  night: [6.5, 13], // 第二幕 痛点：台灯下的“违约金”（匹配剪辑）→ 碎片窗口 → 寂静
  turn: [13, 17], // 第二幕尾 + 第三幕：通用 AI 与三个问题 → 问号的点成为蓝点 → 产品登场
  home: [17, 19.5], // 第三幕：首页分层成形 → 方法库（53 个方法）
  onetake: [19.5, 27], // 第四幕 一件事：一镜到底，从交代到成果
  answers: [27, 34.5], // 第五幕 回答：依据 / 案卷 / 负责
  dawn: [34.5, 40], // 第六幕 升华：同一张桌子，台灯熄灭、晨光 → 价值 → 主题
  finale: [40, 45], // 主题延续 → 产品名 → 中软国际 × Kimi 联袂打造 → 淡出与余音
} as const;

export type SceneKey = keyof typeof BARS;
export const SCENES = Object.fromEntries(Object.entries(BARS).map(([k, [a, b]]) => [k, { from: bars(a), dur: bars(b) - bars(a) }])) as Record<SceneKey, { from: number; dur: number }>;
export const SCENE_BAR = Object.fromEntries(Object.entries(BARS).map(([k, [a]]) => [k, a])) as Record<SceneKey, number>;
export const DURATION = bars(45); // 9000 帧 = 150 秒
