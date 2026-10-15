/**
 * 更新横幅的显示逻辑（W7；复核 B4-B17）：纯函数，可单测。
 * - “已就绪”：按版本记住“稍后”；有进行中或等你处理的任务时不给“现在重启并更新”（关闭应用时自动完成）——任务数由调用方实时计算；
 * - “未通过核验”：可关闭，按版本记住（此前不能关闭，会在除执行页、审查页外的所有页面常驻）。
 */
export type UpdateBannerView =
  | { kind: "ready"; canInstall: boolean; busyNote: boolean; dismissLabel: string }
  | { kind: "rejected" }
  | null;

export function updateBannerView(i: {
  state: string;
  version: string | null | undefined;
  /** 本机记住的“稍后”版本。 */
  laterVersion: string | null;
  /** 本机记住的“已知道未通过核验”版本。 */
  rejectedSeenVersion: string | null;
  /** 进行中与等你处理的任务数。 */
  activeRuns: number;
}): UpdateBannerView {
  if (i.state === "ready") {
    if (i.version && i.laterVersion === i.version) return null;
    const busy = i.activeRuns > 0;
    return { kind: "ready", canInstall: !busy, busyNote: busy, dismissLabel: busy ? "知道了（关闭应用时自动更新）" : "稍后（关闭应用时自动更新）" };
  }
  if (i.state === "rejected") return i.rejectedSeenVersion !== null && i.rejectedSeenVersion === String(i.version ?? "") ? null : { kind: "rejected" };
  return null;
}
