/**
 * 发起前检查的提示条（第 46 批，主文 §5-1）：要重新登录、额度暂停时说清原因，并给一个直达入口（去登录 / 查看本所用量）。
 * 用在开始前确认（RunSheet）与开始面板（ScenarioStart）；是橙色提示，不是红色报错。
 */
import { nav } from "../App.tsx";
import { startHintActionLabel, startHintTarget, type StartHint } from "../lib/start-block.ts";

function go(h: StartHint): void {
  const t = startHintTarget(h);
  if (!t) return;
  if (t.path) nav(t.path);
  // 第 64 批：要重新登录 → 外壳重新取一次登录状态，切到整窗重新登录页（与 AccountPanel 的 ACCOUNT_CHANGED 同一事件）
  if (t.refreshAccount) window.dispatchEvent(new Event("kwl:account-changed"));
  // 换页后等页面画出来再定位
  setTimeout(() => {
    const el = document.querySelector<HTMLElement>(t.anchor);
    el?.scrollIntoView({ block: "center" });
    if (el instanceof HTMLInputElement) el.focus();
  }, t.path ? 300 : 0);
}

export function StartHintBanner({ hint, onAction }: { hint: StartHint; onAction?: () => void }) {
  const label = startHintActionLabel(hint);
  return (
    <div className="banner banner-orange start-hint" role="status">
      <div>{hint.message}</div>
      {label && (
        <div className="banner-actions">
          <button
            className="btn-ghost btn-sm"
            onClick={() => {
              onAction?.();
              go(hint);
            }}
          >
            {label}
          </button>
        </div>
      )}
    </div>
  );
}
