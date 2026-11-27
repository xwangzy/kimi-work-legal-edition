/**
 * 输入框外壳（第 72 批，D-303）：Work 首页 / 事项页的任务输入框与 Chat 问答输入框共用同一个骨架——
 * 同一圆角、描边、阴影、内边距（样式只在 styles.css 的 .composer / .composer-bar 与 styles-composer.css）。
 *   ┌───────────────────────────────────────────────┐
 *   │ 输入区（children）                              │
 *   │ [左槽：+ / 运行模式 / 深度思考]   [右槽：模型] (●) │  ← 发送 / 停止是同一位置的 36px 圆键，生成前后控件不位移
 *   └───────────────────────────────────────────────┘
 * 回车发送、Shift + 回车换行（拍板第 23 项）；中文输入法组字时回车只确认候选、不发送。快捷键不再常驻成一段灰字，写在发送键的悬停提示里。
 */
import type { KeyboardEvent, ReactNode } from "react";
import { Icon } from "./Icons.tsx";
import { isSendEnter } from "../lib/send-key.ts";

export { isSendEnter };

/** textarea 的 onKeyDown：回车发送（阻止换行），Shift + 回车照常换行。 */
export function sendOnEnter(send: () => void) {
  return (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isSendEnter(e)) return;
    e.preventDefault();
    send();
  };
}

export const SEND_TITLE = "发送（回车；Shift + 回车换行）";

export function ComposerFrame({ className, children, left, right, send }: { className?: string; children: ReactNode; left?: ReactNode; right?: ReactNode; send: ReactNode }) {
  return (
    <div className={`composer${className ? ` ${className}` : ""}`}>
      {children}
      <div className="composer-bar">
        {left}
        <span className="spacer" />
        {right}
        {send}
      </div>
    </div>
  );
}

/** 发送 / 停止：同一个 36px 圆键。生成中显示方块（停止），悬停提示“停止（Esc）”。 */
export function SendButton({ busy, disabled, onSend, onStop, blockedReason }: { busy?: boolean; disabled?: boolean; onSend: () => void; onStop?: () => void; blockedReason?: string }) {
  if (busy && onStop)
    return (
      <button type="button" className="send send-stop" onClick={onStop} aria-label="停止生成" title="停止（Esc）">
        <span className="send-stop-sq" aria-hidden="true" />
      </button>
    );
  return (
    <button type="button" className="send" disabled={disabled} onClick={onSend} aria-label={disabled && blockedReason ? `发送（${blockedReason}）` : "发送"} title={disabled && blockedReason ? blockedReason : SEND_TITLE}>
      <Icon.send />
    </button>
  );
}
