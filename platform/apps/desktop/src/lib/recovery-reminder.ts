/**
 * 恢复与备份的提醒（第 14 批第二轮复核 R2B-05）：缺哪一样就说哪一样——没有恢复包、没有设置备份位置、备份盘不是原来那块（R2B-06）、
 * 上次备份没成功、已经几天没有成功备份。返回 null 表示不用提醒。纯函数。
 */
export interface BackupStatusView {
  packages_created?: number;
  configured?: boolean;
  last_error?: string | null;
  stale_days?: number | null;
  revoked?: boolean;
}

export type ReminderKind = "package" | "folder" | "location_changed" | "failed" | "stale";

/** kind：缺恢复包时“去完成”打开开通向导（#/welcome），其余打开“设置 · 本机与安全”。 */
export function recoveryReminder(s: BackupStatusView | null | undefined): { kind: ReminderKind; text: string; tone: "orange" | "red"; everywhere: boolean } | null {
  if (!s || s.revoked) return null;
  if (!s.packages_created) return { kind: "package", text: "完成开通的最后一步：生成恢复包并设置备份。不做的话，这台电脑坏了或丢了，案件数据将无法找回。", tone: "orange", everywhere: false };
  if (!s.configured) return { kind: "folder", text: "还没有设置备份位置：只有恢复包、没有备份，电脑坏了案件数据照样找不回。请插上移动硬盘或选律所共享盘。", tone: "orange", everywhere: false };
  if (s.last_error === "location_changed")
    return { kind: "location_changed", text: "备份盘不是原来那块（可能插的是另一只 U 盘，或原来的备份被移走了），没有备份：请插回原来的备份盘；要换一块，请在“恢复与备份”里重新选择备份位置。", tone: "red", everywhere: true };
  if (s.last_error) return { kind: "failed", text: "上次自动备份没有成功：请检查备份用的移动硬盘是否插好、空间是否够。", tone: "red", everywhere: true };
  if (typeof s.stale_days === "number" && s.stale_days >= 3) return { kind: "stale", text: `已经 ${s.stale_days} 天没有成功备份：请插上备份用的移动硬盘，或打开“恢复与备份”点“立即备份”。`, tone: "orange", everywhere: true };
  return null;
}
