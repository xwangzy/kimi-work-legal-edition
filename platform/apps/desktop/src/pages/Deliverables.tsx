/** 交付件（第 03 篇 §4.1：待复核、待签发、已签发、已外发登记；成果只是草稿，复核签发后才是交付件）。 */
import { useEffect, useRef, useState } from "react";
import { api, type Matter } from "../api.ts";
import { nav } from "../App.tsx";
import { artifactName, AUDIENCE_LABELS, fmtTime } from "../lib/labels.ts";

const STATUS_LABELS: Record<string, string> = { draft: "草稿", pending_review: "待复核", approved: "已签发", rejected: "已退回", superseded: "已被替代" };

export function DeliverablesPage() {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [rows, setRows] = useState<(any & { matter_title: string })[]>([]);
  const [filter, setFilter] = useState<"pending_review" | "draft" | "approved" | "all">("pending_review");
  // 律师没点过分组时，缺省停在第一个非空分组（UIUX 增量评审 DL-1：待复核 → 草稿 → 已签发）
  const touchedRef = useRef(false);
  useEffect(() => {
    api
      .listMatters()
      .then(async (r) => {
        setMatters(r.matters);
        const all: any[] = [];
        for (const m of r.matters.slice(0, 50)) {
          const a = await api.listArtifacts(m.matter_id).catch(() => ({ artifacts: [] as any[] }));
          for (const x of a.artifacts) all.push({ ...x, matter_id: m.matter_id, matter_title: m.title });
        }
        all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        setRows(all);
        const first = (["pending_review", "draft", "approved"] as const).find((k) => all.some((x) => x.status === k));
        if (!touchedRef.current && first) setFilter(first);
      })
      .catch(() => {});
  }, []);
  const shown = rows.filter((r) => filter === "all" || r.status === filter);
  return (
    <main className="main">
      <div className="main-wide">
        <div className="page-head">
          <h1 className="page-title">交付件</h1>
          <div className="seg">
            {(
              [
                ["pending_review", "待复核"],
                ["draft", "草稿"],
                ["approved", "已签发"],
                ["all", "全部"],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                className={`seg-btn${filter === k ? " on" : ""}`}
                onClick={() => {
                  touchedRef.current = true;
                  setFilter(k);
                }}
              >
                {l}（{k === "all" ? rows.length : rows.filter((r) => r.status === k).length}）
              </button>
            ))}
          </div>
        </div>
        <p className="muted">助手与工作流的产物一律是草稿；经律师复核、签发绑定确切版本后才对外。{matters.length > 50 ? "（只列最近 50 个事项）" : ""}</p>
        {shown.length === 0 && (
          <p className="muted">
            {filter === "pending_review" ? "没有待复核的文件。" : filter === "draft" ? "没有草稿。" : filter === "approved" ? "还没有签发的文件。" : "还没有任何成果。"}
            {filter !== "draft" && filter !== "all" && rows.some((r) => r.status === "draft") && (
              <button className="btn-link" onClick={() => setFilter("draft")}>
                草稿里有 {rows.filter((r) => r.status === "draft").length} 份 →
              </button>
            )}
          </p>
        )}
        {shown.length > 0 && (
          <table className="data">
            <thead><tr><th>成果</th><th>事项</th><th>版本</th><th>状态</th><th>受众</th><th>生成</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.artifact_version_id} className="row-link" onClick={() => (r.status === "pending_review" || r.status === "approved" ? nav(`/review/${r.artifact_version_id}`) : r.run_id ? nav(`/run/${r.run_id}/${r.matter_id}`) : nav(`/matter/${r.matter_id}`))}>
                  <td><b>{artifactName({ ...r, title: null })}</b><div className="muted">{r.filename}</div></td>
                  <td>{r.matter_title}</td>
                  <td>v{r.version}</td>
                  <td>{STATUS_LABELS[r.status] ?? r.status}</td>
                  <td>{r.audience ? AUDIENCE_LABELS[r.audience] ?? r.audience : "—"}</td>
                  <td>{fmtTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
