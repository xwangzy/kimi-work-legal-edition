/** 界面内的数据变更通知（新建事项、导入材料、发起任务后刷新侧栏等）；只在渲染进程内存中，不跨窗口、不落盘。 */
const EVENT = "kwl:data-changed";

export function notifyDataChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function onDataChanged(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
