/** 事项列表（第 03 篇 §4.1：个人/团队事项；事项头常显数据模式、密级、依据状态）。 */
import { useEffect, useState } from "react";
import { api, type Matter } from "../api.ts";
import { nav } from "../App.tsx";
import { basisComplete } from "../components/MatterHeader.tsx";
import { NewMatterDialog } from "../components/NewMatter.tsx";
import { fmtTime, LEVEL_LABELS } from "../lib/labels.ts";

export function MattersPage() {
  const [matters, setMatters] = useState<Matter[] | null>(null);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.listMatters().then((r) => setMatters(r.matters)).catch((e) => setErr(e.message));
  }, []);
  const list = (matters ?? []).filter((m) => !q || [m.title, m.client_name, m.counterparty].some((x) => x?.includes(q)));
  return (
    <main className="main">
      <div className="main-wide">
        <div className="page-head">
          <h1 className="page-title">事项</h1>
          <input className="search" placeholder="搜索事项、客户、相对方" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn-primary" onClick={() => setCreating(true)}>新建事项</button>
        </div>
        {err && <div className="banner banner-red">{err}</div>}
        {matters && list.length === 0 && <p className="muted">没有事项。</p>}
        <table className="data matters-table">
          <thead>
            <tr><th>事项</th><th>客户 / 相对方</th><th>立场</th><th>数据模式</th><th>密级</th><th>依据</th><th>协作</th><th>创建</th></tr>
          </thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.matter_id} className="row-link" onClick={() => nav(`/matter/${m.matter_id}`)}>
                <td><b>{m.title}</b>{m.lifecycle === "closed" && <span className="tag tag-gray">已结案</span>}{m.legal_hold && <span className="tag tag-warn">保全</span>}</td>
                <td>{[m.client_name, m.counterparty].filter(Boolean).join(" / ") || "—"}</td>
                <td>{m.stance}</td>
                <td>本地事项</td>
                <td>{m.data_level ? (LEVEL_LABELS[m.data_level] ?? m.data_level) : "—"}</td>
                <td>{m.consent_status === "refused" ? "当事人拒绝（记录）" : (m.basis_complete ?? basisComplete(m.basis)) ? "齐备" : "待确认"}</td>
                <td>{m.collab_scope === "team" ? "团队" : "个人"}</td>
                <td>{fmtTime(m.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && (
        <NewMatterDialog
          onClose={() => setCreating(false)}
          onCreated={(m) => {
            setCreating(false);
            nav(`/matter/${m.matter_id}`);
          }}
        />
      )}
    </main>
  );
}
