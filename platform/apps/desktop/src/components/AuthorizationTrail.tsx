/**
 * 客户授权一行只读 + 历史（D-225）：事项页与签发页共用。
 * “客户授权：委托合同第 12 条 · 11 月 22 日 王主任记录”，点开看每一次记录（只增不改，记录在事项日志里）。
 * 样式：小圆点 + 次要字，不加盒子。
 */
import { useState } from "react";
import type { Matter } from "../api.ts";
import { authorizationRecordLine, authorizationStatus, BASIS_SOURCE_LABELS, monthDay } from "../lib/authorization.ts";
import "../styles-authz.css";

const TONE: Record<string, string> = { valid: "dot-ok", needs_ref: "dot-warn", reconfirm: "dot-warn", pending: "dot-off", local_only: "dot-off" };

export function AuthorizationTrail({ matter }: { matter: Matter }) {
  const [open, setOpen] = useState(false);
  const status = authorizationStatus(matter);
  const history = matter.authorization_history ?? [];
  const line = authorizationRecordLine(matter);
  return (
    <div className="authz-trail">
      {history.length > 0 ? (
        <button type="button" className="authz-trail-line" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={open ? "收起记录" : "查看每一次记录"}>
          <span className={`dot ${TONE[status.key] ?? "dot-off"}`} aria-hidden="true" />
          <span>{line}</span>
        </button>
      ) : (
        <span className="authz-trail-line">
          <span className={`dot ${TONE[status.key] ?? "dot-off"}`} aria-hidden="true" />
          <span>{line}</span>
        </span>
      )}
      {open && history.length > 0 && (
        <ol className="authz-trail-history" aria-label="客户授权的记录">
          {history.map((h, i) => (
            <li key={`${h.recorded_at}-${i}`}>
              {monthDay(h.recorded_at)} · {BASIS_SOURCE_LABELS[h.basis_source] ?? "授权依据"} · {h.basis_ref}
              {h.recorded_by ? ` · ${h.recorded_by}记录` : ""}
              {h.current_version ? "" : " · 按旧的次处理者清单"}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
