/** 渲染 lib/ask.ts 的询问（一次一条）。挂在 App 根上。 */
import { useEffect, useState } from "react";
import { setAskHost, type AskRequest } from "../lib/ask.ts";
import { Modal } from "./Modal.tsx";

export function AskHost() {
  const [cur, setCur] = useState<{ req: AskRequest; done: (v: boolean) => void } | null>(null);
  useEffect(() => {
    setAskHost((req) => new Promise<boolean>((resolve) => setCur({ req, done: resolve })));
    return () => setAskHost(null);
  }, []);
  if (!cur) return null;
  const answer = (v: boolean) => {
    setCur(null);
    cur.done(v);
  };
  return (
    <Modal title={cur.req.title} onClose={() => answer(false)}>
      <p>{cur.req.body}</p>
      <div className="modal-actions">
        <button className="btn-ghost" onClick={() => answer(false)}>{cur.req.no}</button>
        <button className="btn-primary" autoFocus onClick={() => answer(true)}>{cur.req.yes}</button>
      </div>
    </Modal>
  );
}
