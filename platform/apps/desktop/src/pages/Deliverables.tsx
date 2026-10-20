/**
 * 交付件（第 03 篇 §4.1：待复核、草稿、已签发；成果只是草稿，复核签发后才是交付件）。
 * Z3 评审 #2：列表显示律师看得懂的标题（内容标题在本机还原代号；文件名只在悬停时显示），按事项分组；
 * 点任何一行都进入这份文件的详情（左预览、右签发前检查）；每行可直接下载，草稿行可提交复核。
 */
import { useEffect, useRef, useState } from "react";
import { api, type Matter } from "../api.ts";
import { nav } from "../App.tsx";
import { downloadPlan } from "../lib/download.ts";
import { artifactName, AUDIENCE_LABELS, fmtRelative, fmtTime } from "../lib/labels.ts";
import { groupDeliverables } from "../lib/deliverables.ts";
import { restoredPlain, restoreTokens } from "../lib/tokens.ts";

const STATUS_LABELS: Record<string, string> = { draft: "草稿", pending_review: "待复核", approved: "已签发", rejected: "已退回", superseded: "已被替代" };

export function DeliverablesPage() {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [rows, setRows] = useState<(any & { matter_title: string; display: string })[]>([]);
  const [filter, setFilter] = useState<"pending_review" | "draft" | "approved" | "all">("pending_review");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  // 律师没点过分组时，缺省停在第一个非空分组（UIUX 增量评审 DL-1：待复核 → 草稿 → 已签发）
  const touchedRef = useRef(false);
  const load = () =>
    api
      .listMatters()
      .then(async (r) => {
        setMatters(r.matters);
        const all: any[] = [];
        for (const m of r.matters.slice(0, 50)) {
          const a = await api.listArtifacts(m.matter_id).catch(() => ({ artifacts: [] as any[] }));
          // 内容标题是令牌形态：按事项在本机还原后显示（还原结果只在渲染进程内存里）
          const titles = a.artifacts.map((x: any) => String(x.title ?? "")).join("\n");
          const map = titles.includes("〔") ? await restoreTokens(m.matter_id, titles).catch(() => new Map<string, string | null>()) : new Map<string, string | null>();
          for (const x of a.artifacts) all.push({ ...x, matter_id: m.matter_id, matter_title: m.title, display: artifactName(x, (t) => restoredPlain(t, map)) });
        }
        all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        setRows(all);
        const first = (["pending_review", "draft", "approved"] as const).find((k) => all.some((x) => x.status === k));
        if (!touchedRef.current && first) setFilter(first);
      })
      .catch(() => {});
  useEffect(() => {
    void load();
  }, []);
  const shown = rows.filter((r) => filter === "all" || r.status === filter);
  const download = async (r: any) => {
    setErr("");
    setNote("");
    try {
      const saved = await api.downloadArtifact(r.artifact_version_id, r.filename);
      if (!saved) return;
      await api.deliver({ artifact_version_id: r.artifact_version_id, action: "download" });
      setNote(`已保存「${r.display}」（真实名称已还原，下载记在事项日志里）。`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const submit = async (r: any) => {
    setBusyId(r.artifact_version_id);
    setErr("");
    try {
      await api.submitReview(r.artifact_version_id);
      nav(`/review/${r.artifact_version_id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };
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
        <p className="muted">这里的文件都是草稿；你复核并签发后，才是可以对外的版本。{matters.length > 50 ? "（只列最近 50 个事项）" : ""}</p>
        {err && <div className="banner banner-red">{err}</div>}
        {note && <div className="banner banner-gray">{note}</div>}
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
          <table className="data deliverables">
            <thead><tr><th>成果</th><th>版本</th><th>状态</th><th>受众</th><th>生成</th><th className="dl-actions-h">操作</th></tr></thead>
            {groupDeliverables(shown).map((g) => (
              <tbody key={g.matter_id}>
                <tr className="dl-group">
                  <td colSpan={6}>
                    <button className="btn-link" onClick={() => nav(`/matter/${g.matter_id}`)}>{g.matter_title}</button>
                    <span className="muted"> · {g.rows.length} 份</span>
                  </td>
                </tr>
                {g.rows.map((r: any) => (
                  <tr key={r.artifact_version_id} className="row-link" onClick={() => nav(`/review/${r.artifact_version_id}`)}>
                    <td title={r.filename}><b>{r.display}</b></td>
                    <td>v{r.version}</td>
                    <td>{STATUS_LABELS[r.status] ?? r.status}</td>
                    <td>{r.audience ? AUDIENCE_LABELS[r.audience] ?? r.audience : "—"}</td>
                    <td title={fmtTime(r.created_at)}>{fmtRelative(r.created_at)}</td>
                    <td className="dl-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="btn-link" onClick={() => nav(`/review/${r.artifact_version_id}`)}>预览</button>
                      <button className="btn-link" onClick={() => void download(r)}>{downloadPlan(r.filename).label}</button>
                      {r.status === "draft" && (
                        <button className="btn-link" disabled={busyId === r.artifact_version_id} onClick={() => void submit(r)}>提交复核</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        )}
      </div>
    </main>
  );
}

/** 事项页“交付件”标签（Z3 评审 #10）：本事项的成果，与交付件页同样的标题、直达与下载。 */
export function MatterDeliverables({ matterId }: { matterId: string }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api
      .listArtifacts(matterId)
      .then(async (a) => {
        const titles = a.artifacts.map((x: any) => String(x.title ?? "")).join("\n");
        const map = titles.includes("〔") ? await restoreTokens(matterId, titles).catch(() => new Map<string, string | null>()) : new Map<string, string | null>();
        setRows([...a.artifacts].sort((x: any, y: any) => String(y.created_at).localeCompare(String(x.created_at))).map((x: any) => ({ ...x, display: artifactName(x, (t) => restoredPlain(t, map)) })));
      })
      .catch(() => setRows([]));
  }, [matterId]);
  if (rows === null) return <p className="muted">正在载入…</p>;
  if (rows.length === 0) return <p className="muted">本事项还没有成果。任务完成后，生成的文件会出现在这里。</p>;
  return (
    <>
      {err && <div className="banner banner-red">{err}</div>}
      <table className="data deliverables">
        <thead><tr><th>成果</th><th>版本</th><th>状态</th><th>生成</th><th className="dl-actions-h">操作</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.artifact_version_id} className="row-link" onClick={() => nav(`/review/${r.artifact_version_id}`)}>
              <td title={r.filename}><b>{r.display}</b></td>
              <td>v{r.version}</td>
              <td>{STATUS_LABELS[r.status] ?? r.status}</td>
              <td title={fmtTime(r.created_at)}>{fmtRelative(r.created_at)}</td>
              <td className="dl-actions" onClick={(e) => e.stopPropagation()}>
                <button className="btn-link" onClick={() => nav(`/review/${r.artifact_version_id}`)}>预览</button>
                <button
                  className="btn-link"
                  onClick={() =>
                    void api
                      .downloadArtifact(r.artifact_version_id, r.filename)
                      .then((saved) => (saved ? api.deliver({ artifact_version_id: r.artifact_version_id, action: "download" }) : undefined))
                      .catch((e) => setErr((e as Error).message))
                  }
                >
                  {downloadPlan(r.filename).label}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
