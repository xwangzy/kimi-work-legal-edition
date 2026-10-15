/**
 * 危险或不可逆操作的两步确认（Y4 V-5、R-10；复核 S7B-03/S7B-04）：第一下只在原位展开一句说明和两个按钮，第二下才执行。
 * 不用浏览器原生确认框——Electron 下它的按钮是英文 OK/Cancel，且“取消任务”的“取消”按钮反而表示不取消。
 */
import { useState } from "react";

export function ConfirmButton(p: {
  /** 按钮文字（如“删除”“取消任务”）。 */
  label: string;
  /** 展开后的一句说明（写清后果）。 */
  question: string;
  /** 确认按钮文字（缺省“确定{label}”）。 */
  confirmLabel?: string;
  /** 放弃按钮文字（缺省“不了”）。 */
  keepLabel?: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
  /** 第一下的按钮样式（缺省红字描边）；只有不属于危险操作的确认（例如发布）才换样式。 */
  className?: string;
  danger?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const danger = p.danger ?? true;
  if (!asking) {
    return (
      <button className={p.className ?? (danger ? "btn-ghost btn-danger" : "btn-ghost")} disabled={p.disabled} onClick={() => setAsking(true)}>
        {p.label}
      </button>
    );
  }
  return (
    <span className="confirm-inline" role="group" aria-label={p.question}>
      <span className="confirm-q">{p.question}</span>
      <button
        className={danger ? "btn-ghost btn-danger btn-sm" : "btn-ghost btn-sm"}
        disabled={p.disabled}
        onClick={() => {
          setAsking(false);
          void p.onConfirm();
        }}
      >
        {p.confirmLabel ?? `确定${p.label}`}
      </button>
      <button className="btn-ghost btn-sm" autoFocus onClick={() => setAsking(false)}>
        {p.keepLabel ?? "不了"}
      </button>
    </span>
  );
}
