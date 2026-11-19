/**
 * 首页“上手清单”（第 46 批，主文 §5-5）：建事项 → 加材料 → 发起第一个任务 → 查看成果。纯数据与纯函数，可单测。
 *
 * - 完成与否只看真实数据（内核 guide.progress：自己建的事项、自己导入的材料、自己发起的任务、这些任务的成果），做完自动打勾；
 *   按“自己建的”判断，所以有团队共享事项的新成员同样看得到清单；示例事项不算。
 * - 每项有“去做”，直达对应界面；“看看界面”打开原有的聚光讲解。
 * - 收起状态按律所 + 成员分键记在本机（键里只有 8 位摘要，与“看过指南”同一做法）；已经在用的老用户（第一次见到时四项都已完成）不打扰。
 */
import { accountDigest, type GuideStore } from "./guide-steps.ts";

export interface GuideProgress {
  own_matters: number;
  materials: number;
  runs: number;
  deliverables: number;
  latest_matter_id: string | null;
  latest_run: { run_id: string; matter_id: string } | null;
}

export type ChecklistKey = "matter" | "material" | "task" | "result";

export const CHECKLIST: readonly { key: ChecklistKey; title: string; body: string; cta: string }[] = [
  { key: "matter", title: "新建第一个事项", body: "每个案件或项目建一个事项，写明我方立场", cta: "去新建" },
  { key: "material", title: "给事项加材料", body: "把合同、起诉状等文件导入事项，只存在这台电脑上", cta: "去导入" },
  { key: "task", title: "发起第一个任务", body: "在输入框写要做的事，或点下方的业务场景", cta: "去发起" },
  { key: "result", title: "查看成果", body: "AI 写的都是草稿，逐条复核后再导出", cta: "去查看" },
];

export interface ChecklistItem {
  key: ChecklistKey;
  title: string;
  body: string;
  cta: string;
  done: boolean;
}

export function checklistItems(p: GuideProgress): ChecklistItem[] {
  const done: Record<ChecklistKey, boolean> = { matter: p.own_matters > 0, material: p.materials > 0, task: p.runs > 0, result: p.deliverables > 0 };
  return CHECKLIST.map((c) => ({ ...c, done: done[c.key] }));
}

/** “已完成 2 / 4”。 */
export function checklistCounter(items: readonly ChecklistItem[]): string {
  return `已完成 ${items.filter((i) => i.done).length} / ${items.length}`;
}

/** “去做”去哪：新建事项对话框 / 某个页面 / 首页输入框。 */
export type ChecklistAction = { kind: "new_matter" } | { kind: "nav"; path: string } | { kind: "composer" };

export function checklistAction(key: ChecklistKey, p: GuideProgress): ChecklistAction {
  switch (key) {
    case "matter":
      return { kind: "new_matter" };
    case "material":
      return p.latest_matter_id ? { kind: "nav", path: `/matter/${p.latest_matter_id}` } : { kind: "new_matter" };
    case "task":
      return p.own_matters > 0 ? { kind: "composer" } : { kind: "new_matter" };
    case "result":
      return p.latest_run ? { kind: "nav", path: `/run/${p.latest_run.run_id}/${p.latest_run.matter_id}` } : { kind: "nav", path: "/deliverables" };
  }
}

/** 本机记收起状态的键（按律所与成员分开）。 */
export function checklistKey(firm: string | null | undefined, user: string | null | undefined): string {
  return `kwl.checklist.v1.${accountDigest(firm, user)}`;
}

/** 本机记的状态：shown = 显示过（还没收起）；hidden = 已收起；null = 从没显示过。读失败按 null。 */
export function checklistState(store: GuideStore | null | undefined, key: string): "shown" | "hidden" | null {
  try {
    const v = store?.getItem(key);
    return v === "shown" || v === "hidden" ? v : null;
  } catch {
    return null;
  }
}

export function setChecklistState(store: GuideStore | null | undefined, key: string, v: "shown" | "hidden"): void {
  try {
    store?.setItem(key, v);
  } catch {
    // 记不住：下次还会显示，不影响使用
  }
}

/**
 * 显示与否：已收起 → 不显示；还没取到进度 → 不显示；从没显示过而四项都已完成（老用户）→ 悄悄记为收起、不显示；其余显示。
 * 需要重新登录时也照常显示（建事项、加材料都是本机功能）。
 */
export function checklistVisibility(state: "shown" | "hidden" | null, p: GuideProgress | null): "show" | "hide" | "retire" {
  if (state === "hidden" || !p) return "hide";
  if (state === null && checklistItems(p).every((i) => i.done)) return "retire";
  return "show";
}
