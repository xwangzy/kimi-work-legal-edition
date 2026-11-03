/**
 * 在事项页或任务页点“新建任务”时带上当前事项（V10 走查：从“栈桥数据”事项页点新建任务，开始面板预选的是最近新建的另一个事项，
 * 律师不留意就会在别的事项上发起任务、用错材料）。其余页面照旧回首页。
 */
export function newTaskHref(href: string, route: { page: string; matterId?: string }): string {
  return href === "/" && (route.page === "matter" || route.page === "run") && route.matterId ? `/new/${encodeURIComponent(route.matterId)}` : href;
}
