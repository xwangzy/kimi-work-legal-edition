import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons.tsx";

/** 打开着的弹窗（后开的在上）。Esc 只关最上面一个：弹窗里的两步确认对话框按 Esc 不能把外面的弹窗也关掉（第 26 批）。 */
const openStack: object[] = [];

/** Esc 是否该由这个弹窗处理（纯函数，供用例）。 */
export function isTopModal(stack: readonly object[], me: object): boolean {
  return stack[stack.length - 1] === me;
}

/**
 * size：wide = 760px；xl = 1040px（第 66 批开始面板两栏）；card = 840px（第 67 批开始面板单栏）。subtitle：标题下一行小字（例如这张卡得到什么）。
 * headExtra：标题栏右侧、关闭按钮之前的小操作（第 67 批：开始面板的“怎么做”）。
 */
export function Modal({ title, onClose, children, wide, size, subtitle, icon, headExtra }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; size?: "xl" | "card"; subtitle?: ReactNode; icon?: ReactNode; headExtra?: ReactNode }) {
  const me = useRef({}).current;
  useEffect(() => {
    openStack.push(me);
    return () => {
      const i = openStack.lastIndexOf(me);
      if (i >= 0) openStack.splice(i, 1);
    };
  }, [me]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopModal(openStack, me)) onClose();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose, me]);
  // 挂到 document.body（第 26 批走查）：弹窗原来渲染在触发它的元素里，表格单元格、名称胶囊等祖先样式会改掉弹窗里的按钮
  // （例如 `.alias-chip button` 把“确定停用”染成蓝色文字）；React 事件仍沿组件树冒泡，行为不变
  return createPortal(
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " modal-wide" : ""}${size === "xl" ? " modal-xl" : ""}${size === "card" ? " modal-xl modal-card" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className={`modal-head${subtitle ? " modal-head-2" : ""}`}>
          {subtitle || icon ? (
            <span className="modal-titles">
              {icon && <span className="modal-icon" aria-hidden="true">{icon}</span>}
              <span className="modal-title-text">
                <span className="modal-title">{title}</span>
                {subtitle && <span className="modal-subtitle">{subtitle}</span>}
              </span>
            </span>
          ) : (
            <span>{title}</span>
          )}
          <span className="modal-head-actions">
            {headExtra}
            <button className="icon-btn" aria-label="关闭" onClick={onClose}><Icon.x /></button>
          </span>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
