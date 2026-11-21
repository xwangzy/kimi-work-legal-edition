/**
 * 首次使用 AI 的数据去向告知（第 51 批，D-216；逻辑见 lib/ai-notice.ts）。挂在 AskHost 里（App 根上），任何地方 await ensureAiNotice() 即可。
 * 内容只有三件事：数据去哪（三句要点，与“设置 · 数据去向”同一口径）、AI 结果都是草稿须你核对、客户授权按事项另记（这不是客户授权）。
 */
import { useEffect, useState } from "react";
import { setAiNoticeHost } from "../lib/ai-notice.ts";
import { nav } from "../App.tsx";
import { Icon } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import "../styles-authz.css";
import "../styles-motion.css";

export function AiNoticeHost() {
  const [cur, setCur] = useState<{ done: (v: boolean) => void } | null>(null);
  useEffect(() => {
    setAiNoticeHost(() => new Promise<boolean>((resolve) => setCur({ done: resolve })));
    return () => setAiNoticeHost(null);
  }, []);
  if (!cur) return null;
  const answer = (v: boolean) => {
    setCur(null);
    cur.done(v);
  };
  return (
    <Modal title="开始用 AI 之前" onClose={() => answer(false)}>
      <div className="ai-notice">
        <p className="ai-notice-lead">第一次用 AI，先说清楚数据去哪、谁来处理。之后不再提示。</p>
        <ul className="ai-notice-points">
          <li>
            <span className="ai-notice-ico keep" aria-hidden="true">{Icon.lock()}</span>
            <span>
              <b>案卷只在这台电脑</b>
              原件、成果和代号对照表加密保存在本机。
            </span>
          </li>
          <li>
            <span className="ai-notice-ico" aria-hidden="true">{Icon.eye()}</span>
            <span>
              <b>发出前换成代号</b>
              姓名、证件号、电话等先换成代号，再经中软国际转发给月之暗面的 Kimi 模型处理；识别可能遗漏，每次发出的内容都可以在任务的“数据去向”里查看。
            </span>
          </li>
          <li>
            <span className="ai-notice-ico" aria-hidden="true">{Icon.fileCheck()}</span>
            <span>
              <b>结果都是草稿</b>
              引用、事实与结论要由你核对，签发后才能对外。
            </span>
          </li>
        </ul>
        <p className="ai-notice-note">
          这是给你本人的说明，不代表客户已经授权。每个事项第一次用 AI 时，会请你记录这个案子的客户授权依据。
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              answer(false);
              nav("/connections/visibility");
            }}
          >
            看完整的数据去向说明
          </button>
        </p>
      </div>
      <div className="modal-actions">
        <button className="btn-ghost" onClick={() => answer(false)}>
          先不用
        </button>
        <button className="btn-primary" autoFocus onClick={() => answer(true)}>
          我知道了，继续
        </button>
      </div>
    </Modal>
  );
}
