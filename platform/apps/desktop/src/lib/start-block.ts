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

/** 记录同意并重新估价后仍不能开始时的提示（按 block_kind；缺省按“依据待确认”，向后兼容）。 */
export function afterConsentNotice(blockKind: string | null | undefined, sensitive: boolean): string {
  if ((blockKind ?? "consent") === "consent") {
    return sensitive ? "已记录。本事项为敏感事项，还需在“逐项调整”中确认“敏感信息特别条件”。" : "已记录，但仍有待确认项，请展开“逐项调整”检查。";
  }
  return "已记录客户同意。现在还不能开始，原因见上方。";
}
