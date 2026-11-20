/**
 * 发起被拦时的提示与入口（复核 B4-B13）：按内核给出的 block_kind 选文字与“查看进行中的任务”入口。纯函数，可单测。
 * - 估价不忙、发起时 409（并发发起）：内核在错误里带进行中任务的编号（detail.run_id），同样给出入口；
 * - 记录客户同意后重新估价仍不能开始：只有“依据待确认”才提示去“逐项调整”，事项里另有任务或退出模式时如实说原因在上方。
 */

/** 发起或重试被拒时内核给出的进行中任务编号（409 + detail.run_id）；不是这类错误返回 null。 */
export function busyRunOfError(e: unknown): string | null {
  const x = e as { code?: unknown; detail?: { run_id?: unknown } | null } | null;
  return x && x.code === "conflict" && typeof x.detail?.run_id === "string" ? x.detail.run_id : null;
}

/** 记录授权并重新估价后仍不能开始时的提示（按 block_kind；缺省按“依据待确认”，向后兼容）。 */
export function afterConsentNotice(blockKind: string | null | undefined, sensitive: boolean): string {
  if ((blockKind ?? "consent") === "consent") {
    return sensitive ? "已记录。本事项为敏感事项，还需在“逐项记录”中确认“敏感信息特别条件”。" : "已记录，但仍有待确认项，请打开“逐项记录”检查。";
  }
  return "已记录客户授权。现在还不能开始，原因见上方。";
}

/**
 * 发起前检查给出的提示（第 46 批，主文 §5-1）：要重新登录、客户端过旧、额度暂停时内核不排队，给原因与办法（data_where.start_hint，
 * 或 runs.start 拒绝时的 detail.start_hint）。界面显示成可操作的提示（橙色 + 入口），不当红色报错。
 */
export interface StartHint {
  kind: "login" | "outdated" | "quota";
  code: string;
  message: string;
  action: "login" | "usage" | null;
}

/** 从估价结果的 start_hint 或发起错误的 detail.start_hint 里取提示；不是这类提示返回 null。 */
export function startHintOf(x: unknown): StartHint | null {
  const o = x as { detail?: { start_hint?: unknown } | null; start_hint?: unknown } | null;
  const h = (o && typeof o === "object" && "kind" in o ? o : (o?.detail?.start_hint ?? o?.start_hint ?? null)) as Partial<StartHint> | null;
  if (!h || (h.kind !== "login" && h.kind !== "outdated" && h.kind !== "quota") || typeof h.message !== "string" || h.message === "") return null;
  return { kind: h.kind, code: typeof h.code === "string" ? h.code : "", message: h.message, action: h.action === "login" || h.action === "usage" ? h.action : null };
}

/** 提示上的入口按钮文字（没有入口为 null）。 */
export function startHintActionLabel(h: StartHint): string | null {
  return h.action === "login" ? "去登录" : h.action === "usage" ? "查看本所用量" : null;
}

/** 入口去哪：登录 = 页面顶部的登录框（不换页）；用量 = 设置 → 套餐与用量。 */
export function startHintTarget(h: StartHint): { path: string | null; anchor: string } | null {
  if (h.action === "login") return { path: null, anchor: ".login-banner input" };
  if (h.action === "usage") return { path: "/connections/usage", anchor: "#sec-usage" };
  return null;
}
