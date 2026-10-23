/**
 * 危险或不可逆操作的两步确认（Y4 V-5、R-10；复核 S7B-03/S7B-04）：第一下只在原位展开一句说明和两个按钮，第二下才执行。
 * 不用浏览器原生确认框——Electron 下它的按钮是英文 OK/Cancel，且“取消任务”的“取消”按钮反而表示不取消。
 * 第 26 批（评审 U2-21）：说明超过 20 字的改成居中的对话框（标题“{label}？”，正文是后果），不再把长句塞进表格行；
 * 放弃按钮缺省“取消”（原来“不了”）；危险操作的确认按钮红色实心，和放弃按钮分得开；默认焦点在放弃上，Esc 放弃。
 */
import { useState } from "react";
import { Modal } from "./Modal.tsx";

/** 行内确认的说明上限（字）；更长的用对话框。 */
export const INLINE_QUESTION_MAX = 20;

export function ConfirmButton(p: {
  /** 按钮文字（如“删除”“取消任务”）。 */
  label: string;
  /** 展开后的一句说明（写清后果）。 */
  question: string;
  /** 确认按钮文字（缺省“确定{label}”）。 */
  confirmLabel?: string;
  /** 放弃按钮文字（缺省“取消”）。 */
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
  const confirm = (
    <button
      className={danger ? "btn-danger-solid btn-sm" : "btn-primary btn-sm"}
      disabled={p.disabled}
      onClick={() => {
        setAsking(false);
        void p.onConfirm();
      }}
    >
      {p.confirmLabel ?? `确定${p.label}`}
    </button>
  );
  const keep = (
    <button className="btn-ghost btn-sm" autoFocus onClick={() => setAsking(false)}>
      {p.keepLabel ?? "取消"}
    </button>
  );
  if ([...p.question].length > INLINE_QUESTION_MAX) {
    return (
      <>
        <button className={p.className ?? (danger ? "btn-ghost btn-danger" : "btn-ghost")} disabled>
          {p.label}
        </button>
        <Modal title={`${p.label.replace(/[…?？]+$/, "")}？`} onClose={() => setAsking(false)}>
          <p className="confirm-dialog-q">{p.question}</p>
          <div className="modal-actions">
            {keep}
            {confirm}
          </div>
        </Modal>
      </>
    );
  }
  return (
    <span className="confirm-inline" role="group" aria-label={p.question}>
      <span className="confirm-q">{p.question}</span>
      {confirm}
      {keep}
    </span>
  );
}
