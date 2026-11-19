/**
 * 首次上手指南（2026-11 正式产品：去掉示例事项后，用一分钟的引导代替“先拿示例试一遍”）。纯数据与纯函数，可单测。
 *
 * 顺序按律师真实的工作顺序：先建事项 → 描述任务或选业务场景 → 确认计划、复核成果 → 盯期限、随时问。
 * 每步一句标题、一两句说明，指向界面上真实的位置（data-tour 锚点）；找不到锚点时居中显示，不影响阅读。
 * 只在这台电脑上记“看过了”（按律所与成员分开），设置 · 通用里可以再看一遍。
 */

export interface GuideStep {
  key: "welcome" | "matter" | "task" | "review" | "keep";
  /** 步骤标题（一句话）。 */
  title: string;
  /** 说明（一两句，律师语言，不出现研发用语）。 */
  body: string;
  /** 指向的界面位置：data-tour 属性值；多个时框住它们的外接矩形；空表示居中。 */
  anchors: string[];
}

export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    key: "welcome",
    title: "欢迎使用 Kimi Work 法律版",
    body: "用 AI 帮你整理案卷、审合同、起草文书。花一分钟认识四个要点，随时可以跳过。",
    anchors: [],
  },
  {
    key: "matter",
    title: "先建事项",
    body: "每个案件或项目建一个事项，写明我方立场。材料和成果都归在事项里，只存在这台电脑上。",
    anchors: ["nav-matters"],
  },
  {
    key: "task",
    title: "描述任务，或选业务场景",
    body: "在输入框写要做的事，点“+”导入材料；也可以点下方的业务场景（整理案卷、审合同、起草文书……）直接开始。",
    anchors: ["composer", "scenarios"],
  },
  {
    key: "review",
    title: "确认计划，复核成果",
    body: "开始前先给你看计划；联网或用到当事人信息前会先问你。AI 写的都是草稿，在“成果”里逐条复核后再导出。",
    anchors: ["nav-deliverables"],
  },
  {
    key: "keep",
    title: "盯期限，随时问",
    body: "“期限提醒”帮你盯答辩期、上诉期等关键日期；“问答”随时查法条。左下角是账号、备份与设置。",
    anchors: ["nav-reminders", "nav-chat"],
  },
];

/** 指南内容有实质变化时加一，已看过旧版的人会再看到一次。 */
export const GUIDE_VERSION = 1;

/**
 * 本机记“看过了”的键：按律所与成员分开（同一台电脑上换人登录时各看各的）。键里不写律所、成员标识原文，只写 8 位摘要
 * （FNV-1a 32 位；只用于区分，不可读出身份），与其他本机偏好键一样不含身份或案件信息（docs/privacy/residency.json 登记）。
 */
export function guideSeenKey(firm: string | null | undefined, user: string | null | undefined): string {
  let h = 0x811c9dc5;
  for (const ch of `${firm || "-"}/${user || "-"}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `kwl.guide.v${GUIDE_VERSION}.${h.toString(16).padStart(8, "0")}`;
}

/** 本机偏好读写（localStorage；读写失败时按“没看过”，最多多看一次）。 */
export interface GuideStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export function guideSeen(store: GuideStore | null | undefined, key: string): boolean {
  try {
    return store?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function markGuideSeen(store: GuideStore | null | undefined, key: string): void {
  try {
    store?.setItem(key, "1");
  } catch {
    // 记不住：下次启动再看一次，不影响使用
  }
}

/**
 * 是否自动打开指南：没看过、在首页、而且还没有自己的事项（已经在用的人不打扰，示例事项不算“自己的”）。
 * 待激活、需要重新登录时不打开（那时界面上是激活页或登录框）。
 */
export function shouldAutoOpenGuide(o: { seen: boolean; onHome: boolean; ownMatters: number; loginRequired: boolean }): boolean {
  return !o.seen && o.onHome && !o.loginRequired && o.ownMatters === 0;
}

/** 步骤计数文字：“2 / 5”。 */
export function stepCounter(i: number, total = GUIDE_STEPS.length): string {
  return `${i + 1} / ${total}`;
}

/**
 * 说明卡放在哪里（纯函数，便于单测）：锚点在左侧窄条（侧栏）→ 放右侧；锚点在上半屏 → 放下方；否则放上方；
 * 都放不下时居中。返回卡片左上角坐标（视口像素）。
 */
export function placeCard(
  rect: { left: number; top: number; width: number; height: number } | null,
  view: { width: number; height: number },
  card: { width: number; height: number },
  gap = 14,
): { left: number; top: number; side: "right" | "below" | "above" | "center" } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const center = { left: Math.round((view.width - card.width) / 2), top: Math.round((view.height - card.height) / 2), side: "center" as const };
  if (!rect) return center;
  const margin = 12;
  if (rect.left + rect.width < view.width * 0.3 && rect.left + rect.width + gap + card.width <= view.width - margin) {
    return { left: Math.round(rect.left + rect.width + gap), top: Math.round(clamp(rect.top + rect.height / 2 - card.height / 2, margin, view.height - card.height - margin)), side: "right" };
  }
  const left = Math.round(clamp(rect.left + rect.width / 2 - card.width / 2, margin, view.width - card.width - margin));
  if (rect.top + rect.height + gap + card.height <= view.height - margin) return { left, top: Math.round(rect.top + rect.height + gap), side: "below" };
  if (rect.top - gap - card.height >= margin) return { left, top: Math.round(rect.top - gap - card.height), side: "above" };
  return center;
}

/** 多个锚点的外接矩形（只算看得见的：宽高为 0 的跳过）。 */
export function unionRect(rects: { left: number; top: number; width: number; height: number }[]): { left: number; top: number; width: number; height: number } | null {
  const vis = rects.filter((r) => r.width > 0 && r.height > 0);
  if (vis.length === 0) return null;
  const left = Math.min(...vis.map((r) => r.left));
  const top = Math.min(...vis.map((r) => r.top));
  const right = Math.max(...vis.map((r) => r.left + r.width));
  const bottom = Math.max(...vis.map((r) => r.top + r.height));
  return { left, top, width: right - left, height: bottom - top };
}
