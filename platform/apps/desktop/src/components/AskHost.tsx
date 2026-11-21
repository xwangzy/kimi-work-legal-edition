/** 渲染 lib/ask.ts 的询问（一次一条）。挂在 App 根上。第 51 批：首次使用 AI 的告知（AiNoticeHost）共用这个挂载点。 */
import { useEffect, useState } from "react";
import { setAskHost, type AskRequest } from "../lib/ask.ts";
import { Modal } from "./Modal.tsx";
import { AiNoticeHost } from "./AiNotice.tsx";

export function AskHost() {
  const [cur, setCur] = useState<{ req: AskRequest; done: (v: boolean) => void } | null>(null);
  useEffect(() => {
    setAskHost((req) => new Promise<boolean>((resolve) => setCur({ req, done: resolve })));
    return () => setAskHost(null);
  }, []);
  const answer = (v: boolean) => {
    if (!cur) return;
    setCur(null);
    cur.done(v);
  };
  return (
    <>
      <AiNoticeHost />
      {cur && (
        <Modal title={cur.req.title} onClose={() => answer(false)}>
          <p>{cur.req.body}</p>
          <div className="modal-actions">
            <button className="btn-ghost" onClick={() => answer(false)}>{cur.req.no}</button>
            <button className="btn-primary" autoFocus onClick={() => answer(true)}>{cur.req.yes}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
