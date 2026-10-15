/** 事项列表（第 03 篇 §4.1：个人/团队事项；事项头常显数据模式、密级、依据状态）。 */
import { useEffect, useState } from "react";
import { api, type Matter } from "../api.ts";
import { nav } from "../App.tsx";
import { basisComplete } from "../components/MatterHeader.tsx";
import { NewMatterDialog } from "../components/NewMatter.tsx";
import { fmtRelative, fmtTime, LEVEL_LABELS, matterProgress } from "../lib/labels.ts";
import { stanceLabel } from "../lib/labels.ts";

export function MattersPage() {
  const [matters, setMatters] = useState<Matter[] | null>(null);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.listMatters().then((r) => setMatters(r.matters)).catch((e) => setErr(e.message));
  }, []);
  // 示例事项置顶（Y4 §5 D-6）
  const list = (matters ?? []).filter((m) => !q || [m.title, m.client_name, m.counterparty].some((x) => x?.includes(q))).sort((a, b) => Number(!!b.is_sample) - Number(!!a.is_sample));
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
        {/* 列以律师关心的“进展”和“最近活动”为主（v9.2 §4.4；Y4 M-1）；密级、依据、协作等系统属性收进悬停说明 */}
        <table className="data matters-table">
          <thead>
            <tr><th>事项</th><th>客户 / 相对方</th><th>我方</th><th>进展</th><th>最近活动</th></tr>
          </thead>
          <tbody>
            {list.map((m) => {
              const attrs = [
                `保护：${m.data_level ? (LEVEL_LABELS[m.data_level] ?? m.data_level) : "—"}`,
                `客户同意与依据：${m.consent_status === "refused" ? "当事人拒绝（记录）" : (m.basis_complete ?? basisComplete(m.basis)) ? "齐备" : "待确认"}`,
                `协作：${m.collab_scope === "team" ? "团队" : "个人"}`,
                `创建：${fmtTime(m.created_at)}`,
              ].join("\n");
              const prog = matterProgress(m.activity);
              return (
                <tr key={m.matter_id} className="row-link" title={attrs} onClick={() => nav(`/matter/${m.matter_id}`)}>
                  <td className="matter-name"><b>{m.title}</b>{m.is_sample && <span className="tag tag-trial">示例</span>}{m.lifecycle === "closed" && <span className="tag tag-gray">已结案</span>}{m.legal_hold && <span className="tag tag-warn">保全</span>}</td>
                  <td>{[m.client_name, m.counterparty].filter(Boolean).join(" / ") || "—"}</td>
                  <td>{stanceLabel(m.stance)}</td>
                  <td>{prog.length === 0 ? <span className="muted">—</span> : prog.map((p) => <span key={p.text} className={`pill pill-${p.tone}`}>{p.text}</span>)}</td>
                  <td className="nowrap">{fmtRelative(m.activity?.last_at ?? m.created_at)}</td>
                </tr>
              );
            })}
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
