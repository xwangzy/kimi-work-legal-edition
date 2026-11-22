/**
 * 各事项授权记录（D-225；设置 → 数据去向）：给律所合规检查用的一处只读总览——事项、依据、出处、记录时间、状态，可导出 CSV。
 * 数据只取事项列表已经返回的字段（不另读事项内容）；导出走现有的保存通道，保存位置按“含案件信息”提示。
 */
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { fmtTime } from "../lib/labels.ts";
import { authorizationCsv, authorizationRows, type AuthorizationRow } from "../lib/authorization.ts";
import "../styles-authz.css";

export function AuthorizationOverview() {
  const [rows, setRows] = useState<AuthorizationRow[] | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    api
      .listMatters()
      .then((r) => setRows(authorizationRows(r.matters)))
      .catch(() => setRows(null));
  }, []);
  if (!rows) return null;
  const exportCsv = async () => {
    setNote("");
    try {
      const day = new Date().toISOString().slice(0, 10);
      const ok = await api.saveCaseText(`各事项客户授权记录-${day}.csv`, authorizationCsv(rows));
      if (ok) setNote("已导出");
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  return (
    <div className="authz-overview">
      <div className="authz-overview-head">
        <h3>各事项授权记录</h3>
        <span className="muted">{rows.length} 个事项</span>
        {rows.length > 0 && (
          <button type="button" className="btn-link" onClick={() => void exportCsv()}>
            导出
          </button>
        )}
        {note && <span className="muted">{note}</span>}
      </div>
      {rows.length === 0 ? (
        <p className="muted">还没有事项。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>事项</th>
              <th>依据</th>
              <th>出处</th>
              <th>记录时间</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.matter_id}>
                <td>{r.title}</td>
                <td>{r.basis || "—"}</td>
                <td>{r.ref || "—"}</td>
                <td>
                  {r.recorded_at ? fmtTime(r.recorded_at) : "—"}
                  {r.recorded_by ? ` · ${r.recorded_by}` : ""}
                </td>
                <td>{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
