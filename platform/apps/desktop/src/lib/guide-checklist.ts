/**
 * 首页“上手清单”（第 46 批，主文 §5-5）：建事项 → 加材料 → 发起第一个任务 → 查看成果。纯数据与纯函数，可单测。
 *
 * - 完成与否只看真实数据（内核 guide.progress：我在其中的事项、自己导入的材料、自己发起的任务、这些任务的成果），做完自动打勾；示例事项不算。
 *   第 73 批：第 1 步把同事加进来的团队共享事项也算上（内核 own_matters 口径变了）；只是被加进来、自己没建过时写“已有事项”，不写“建事项”。
 * - 每项有“去做”，直达对应界面；“看看界面”打开原有的聚光讲解。
 * - 收起状态按律所 + 成员分键记在本机（键里只有 8 位摘要，与“看过指南”同一做法）；已经在用的老用户（第一次见到时四项都已完成）不打扰。
 *
 * 第 72 批（D-302）：
 * - 四步改成“建事项 → 加材料 → 发起任务 → 复核成果”，第一步与“发送时就地归属”合流（写任务、按发送即可建事项）；
 * - 第五项“备份这台电脑”：第一个事项有了材料才点亮（之前没有可丢的数据），完成 = 有恢复包且设了备份位置；
 * - 账号已上手（云端 onboarding.completed_at）而这台电脑是新的 → “新电脑版”三项，不再叫老律师“新建第一个事项”；
 * - 角色：个人律师四步 + 备份；团队管理员前面多一组“团队”（可整组跳过）；团队成员加一句“事项内容只在你的电脑”。
 */
import { accountDigest, type GuideStore } from "./guide-steps.ts";

export interface GuideProgress {
  /** 我在其中的事项（第 73 批起含同事把我加进的团队共享事项）。 */
  own_matters: number;
  /** 其中我自己建的 / 同事建、把我加进来的（第 73 批；旧内核没有）。 */
  created_matters?: number;
  shared_matters?: number;
  materials: number;
  runs: number;
  deliverables: number;
  latest_matter_id: string | null;
  latest_run: { run_id: string; matter_id: string } | null;
}

export type ChecklistKey = "matter" | "material" | "task" | "result" | "backup" | "device" | "restore" | "folder";

export const CHECKLIST: readonly { key: ChecklistKey; title: string; body: string; cta: string }[] = [
  { key: "matter", title: "建事项", body: "写下要做的事，发送时建事项", cta: "去建事项" },
  { key: "material", title: "加材料", body: "导入合同、起诉状等，只存本机", cta: "去导入" },
  { key: "task", title: "发起任务", body: "写清要做的事，或选业务场景", cta: "去发起" },
  { key: "result", title: "复核成果", body: "AI 写的是草稿，逐条复核", cta: "去复核" },
  { key: "backup", title: "备份电脑", body: "恢复包与备份位置", cta: "去备份" },
];

/** 新电脑版（账号已上手、这台电脑是新的）：三项。 */
export const NEW_DEVICE_CHECKLIST: readonly { key: ChecklistKey; title: string; body: string; cta: string }[] = [
  { key: "device", title: "这台电脑独立保存", body: "事项与材料只在各自的电脑上，不会自动同步过来", cta: "知道了" },
  { key: "restore", title: "从备份恢复（如有）", body: "有旧电脑的恢复包与备份时，在“备份与安全”里恢复", cta: "去恢复" },
  { key: "folder", title: "选备份位置", body: "选一块移动硬盘或网盘目录，自动备份这台电脑", cta: "去选择" },
];

export interface ChecklistItem {
  key: ChecklistKey;
  title: string;
  body: string;
  cta: string;
  done: boolean;
  /** 还不到做的时候（备份：第一个事项有了材料才点亮）。 */
  locked?: boolean;
}

/** 这台电脑的备份情况（recovery.backup_status 的两项）：没取到时按“没做”。 */
export interface BackupFacts {
  packages_created?: boolean | number | null;
  configured?: boolean | null;
}

export function checklistItems(p: GuideProgress, backup?: BackupFacts | null): ChecklistItem[] {
  const backupDone = !!backup?.packages_created && !!backup?.configured;
  const done: Partial<Record<ChecklistKey, boolean>> = { matter: p.own_matters > 0, material: p.materials > 0, task: p.runs > 0, result: p.deliverables > 0, backup: backupDone };
  return CHECKLIST.map((c) => ({ ...c, ...(c.key === "matter" ? matterStepText(p) : {}), done: !!done[c.key], ...(c.key === "backup" && p.materials === 0 ? { locked: true } : {}) }));
}

/**
 * 第 1 步的说法（第 73 批）：只是被同事加进团队共享事项、自己还没建过时，打勾的不是“建事项”——如实写“已有事项”与来由。纯函数。
 */
export function matterStepText(p: Pick<GuideProgress, "own_matters" | "created_matters" | "shared_matters">): { title: string; body: string } | Record<string, never> {
  const shared = p.shared_matters ?? 0;
  if (p.own_matters > 0 && p.created_matters === 0 && shared > 0) return { title: "已有事项", body: `同事把你加进了 ${shared} 个事项；自己的事项也可以随时新建` };
  return {};
}

/** 新电脑版三项：第一项点“知道了”即完成（本机记）；选备份位置按真实状态。 */
export function newDeviceItems(acked: boolean, backup?: BackupFacts | null): ChecklistItem[] {
  const done: Partial<Record<ChecklistKey, boolean>> = { device: acked, restore: acked && !!backup?.packages_created, folder: !!backup?.configured };
  return NEW_DEVICE_CHECKLIST.map((c) => ({ ...c, done: !!done[c.key] }));
}

/** 上手清单的版本：新律师（完整版）/ 老律师新电脑（新电脑版）。账号级状态取不到（旧云端）时一律按完整版。 */
export type ChecklistVariant = "full" | "new_device";
export function checklistVariant(acct: { supported: boolean; completed_at?: string | null } | null, p: GuideProgress): ChecklistVariant {
  const fresh = p.own_matters === 0 && p.materials === 0 && p.runs === 0;
  return acct?.supported && acct.completed_at && fresh ? "new_device" : "full";
}

/** 角色（D-302 第 5 条）：内核给了 workspace_kind 就按它；没给时按成员角色与“个人账号”标记推断。 */
export type OnboardRole = "personal" | "team_admin" | "team_member";
export function onboardRole(s: { workspace_kind?: string | null; member_role?: string | null } | null, personal?: boolean | null): OnboardRole {
  const admin = s?.member_role === "firm_admin";
  if (s?.workspace_kind === "personal") return "personal";
  if (s?.workspace_kind === "team") return admin ? "team_admin" : "team_member";
  if (personal) return "personal";
  return admin ? "team_admin" : "team_member";
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
      // 第 72 批（D-301 合流）：写任务、按发送时就地新建事项
      return { kind: "composer" };
    case "material":
      return p.latest_matter_id ? { kind: "nav", path: `/matter/${p.latest_matter_id}` } : { kind: "new_matter" };
    case "task":
      return p.own_matters > 0 ? { kind: "composer" } : { kind: "new_matter" };
    case "result":
      return p.latest_run ? { kind: "nav", path: `/run/${p.latest_run.run_id}/${p.latest_run.matter_id}` } : { kind: "nav", path: "/deliverables" };
    case "backup":
    case "restore":
    case "folder":
      return { kind: "nav", path: "/connections/backup" };
    case "device":
      return { kind: "composer" };
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
export function checklistVisibility(state: "shown" | "hidden" | null, p: GuideProgress | null, acct?: { dismissed_at?: string | null } | null): "show" | "hide" | "retire" {
  if (state === "hidden" || !p) return "hide";
  // 第 72 批：账号在别的电脑上收起过清单（云端 dismissed_at）——这台电脑第一次见到时也不再打扰（头像菜单“上手指南”仍可恢复）
  if (state === null && acct?.dismissed_at) return "retire";
  if (state === null && checklistItems(p).slice(0, 4).every((i) => i.done)) return "retire";
  return "show";
}
