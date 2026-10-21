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
  if (!s.packages_created) return { kind: "package", text: "还没有生成恢复包：这台电脑坏了或丢了，案卷就找不回。", tone: "orange", everywhere: false };
  if (!s.configured) return { kind: "folder", text: "还没有设置备份位置：只有恢复包、没有备份，案卷照样找不回。", tone: "orange", everywhere: false };
  if (s.last_error === "location_changed")
    return { kind: "location_changed", text: "备份盘不是原来那块，这次没有备份：请插回原来的备份盘，或重新选择备份位置。", tone: "red", everywhere: true };
  if (s.last_error) return { kind: "failed", text: "上次自动备份没有成功：请检查移动硬盘是否插好、空间是否够。", tone: "red", everywhere: true };
  if (typeof s.stale_days === "number" && s.stale_days >= 3) return { kind: "stale", text: `已经 ${s.stale_days} 天没有成功备份：请插上备份用的移动硬盘。`, tone: "orange", everywhere: true };
  return null;
}

/**
 * “明天提醒”（v9.4 U1 #18）：橙色提醒可以推到明天（只记在这台电脑的本地偏好里）；红色（备份失败、备份盘不对）不能推迟。纯函数。
 * snoozedUntil 是本地日期“YYYY-MM-DD”，today 同格式。
 */
export function reminderSnoozed(r: { tone: "orange" | "red" } | null, snoozedUntil: string | null, today: string): boolean {
  return !!r && r.tone === "orange" && !!snoozedUntil && today < snoozedUntil;
}

/** 本地日期（YYYY-MM-DD），加 days 天。 */
export function localDay(days = 0, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
