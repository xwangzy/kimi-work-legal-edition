/**
 * 交付件（第 03 篇 §4.1：待复核、草稿、已签发；成果只是草稿，复核签发后才是交付件）。
 * Z3 评审 #2：列表显示律师看得懂的标题（内容标题在本机还原代号；文件名只在悬停时显示），按事项分组；
 * 点任何一行都进入这份文件的详情（左预览、右签发前检查）；每行可直接下载，草稿行可提交复核。
 */
import { useEffect, useRef, useState } from "react";
import { api, type Matter } from "../api.ts";
import { nav } from "../App.tsx";
import { downloadPlan } from "../lib/download.ts";
import { ARTIFACT_STATUS_LABELS, artifactName, AUDIENCE_LABELS, fmtTime, fmtWhen } from "../lib/labels.ts";
import { deliveryPackage, groupByTask, groupDeliverables, PACKAGE_REASON_TEXT, taskCountText, taskGroupLabel } from "../lib/deliverables.ts";
import { restoredPlain, restoreTokens } from "../lib/tokens.ts";

const STATUS_LABELS = ARTIFACT_STATUS_LABELS;
const STATUS_TONE: Record<string, string> = { draft: "pill-gray", pending_review: "pill-orange", approved: "pill-green", rejected: "pill-red", superseded: "pill-gray" };

/** 状态胶囊（v9.4 U1 #15）：版本与受众不再各占一列——第 2 版起才写版数，受众放悬停提示。 */
function StatusPill({ r }: { r: { status: string; version: number; audience?: string | null } }) {
  return (
    <span className={`pill ${STATUS_TONE[r.status] ?? "pill-gray"}`} title={r.audience ? `受众：${AUDIENCE_LABELS[r.audience] ?? r.audience}` : undefined}>
      {STATUS_LABELS[r.status] ?? r.status}
      {r.version > 1 ? ` · 第 ${r.version} 版` : ""}
    </span>
  );
}

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
            {/* 按状态筛选时每行状态都一样：不成列（第 27 批，评审 U3-29 / 规则 5）；只有“全部”时显示 */}
            <thead><tr><th>成果</th>{filter === "all" && <th>状态</th>}<th>生成</th><th className="dl-actions-h">操作</th></tr></thead>
            {groupDeliverables(shown).map((g) => (
              <tbody key={g.matter_id}>
                <tr className="dl-group">
                  <td colSpan={filter === "all" ? 4 : 3}>
                    <button className="btn-link" onClick={() => nav(`/matter/${g.matter_id}`)}>{g.matter_title}</button>
                    <span className="muted"> · {g.rows.length} 份</span>
                  </td>
                </tr>
                {/* 事项下再按“一次任务”分组（Astra M-3）：这次要交给客户的那几份成组列出 */}
                {groupByTask(g.rows).flatMap((t) => [
                  <tr key={`task-${t.run_id ?? "none"}`} className="dl-task">
                    <td colSpan={filter === "all" ? 4 : 3}>
                      <span>{taskGroupLabel(t, (iso) => fmtWhen(iso))}</span>
                      {/* 组头写这次任务一共几份（复核 RB16B-11：状态筛选之后只显示一部分时说清） */}
                      <span className="muted"> · {taskCountText(t.rows.length, rows.filter((r) => r.matter_id === g.matter_id && (r.run_id ?? null) === t.run_id).length)}</span>
                      {t.run_id && (
                        <button className="btn-link" onClick={() => nav(`/run/${t.run_id}/${g.matter_id}`)}>
                          看这次任务
                        </button>
                      )}
                    </td>
                  </tr>,
                  ...t.rows.map((r: any) => (
                    <tr key={r.artifact_version_id} className="row-link dl-in-task" onClick={() => nav(`/review/${r.artifact_version_id}`)}>
                      <td title={r.filename}>
                        <b>{r.display}</b>
                        {/* 状态列不显示时，版本与受众补在名称后（复核 Q8-13：已签发里给法院、给客户的要分得清） */}
                        {filter !== "all" && r.audience && r.audience !== "internal" ? <span className="muted"> · 给{AUDIENCE_LABELS[r.audience] ?? r.audience}</span> : null}
                        {filter !== "all" && r.version > 1 ? <span className="muted"> · 第 {r.version} 版</span> : null}
                      </td>
                      {filter === "all" && <td><StatusPill r={r} /></td>}
                      <td className="nowrap" title={fmtTime(r.created_at)}>{fmtWhen(r.created_at)}</td>
                      {/* 每行只留下载与提交复核（v9.4 U1 #15）；点整行就是预览。第 27 批（评审 U3-29）：改小按钮，一屏不再是十几个蓝色链接 */}
                      <td className="dl-actions" onClick={(e) => e.stopPropagation()}>
                        {r.status === "draft" && (
                          <button className="btn-ghost btn-sm" disabled={busyId === r.artifact_version_id} onClick={() => void submit(r)}>提交复核</button>
                        )}
                        <button className="btn-ghost btn-sm" aria-label={downloadPlan(r.filename).label} title={downloadPlan(r.filename).label} onClick={() => void download(r)}>下载</button>
                      </td>
                    </tr>
                  )),
                ])}
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
  // 预览交付包（v9.4 第 21 批）：展开的是哪一次任务
  const [pack, setPack] = useState<string | null>(null);
  const [packNote, setPackNote] = useState("");
  const download = (r: any) =>
    api
      .downloadArtifact(r.artifact_version_id, r.filename)
      .then((saved) => (saved ? api.deliver({ artifact_version_id: r.artifact_version_id, action: "download" }).then(() => true) : false))
      .catch((e) => {
        setErr((e as Error).message);
        return false;
      });
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
        <thead><tr><th>成果</th><th>状态</th><th>生成</th><th className="dl-actions-h">操作</th></tr></thead>
        <tbody>
          {groupByTask(rows).flatMap((t) => [
            <tr key={`task-${t.run_id ?? "none"}`} className="dl-task">
              <td colSpan={4}>
                <span>{taskGroupLabel(t, (iso) => fmtWhen(iso))}</span>
                <span className="muted"> · {t.rows.length} 份</span>
                {t.run_id && (
                  <button className="btn-link" onClick={() => nav(`/run/${t.run_id}/${matterId}`)}>
                    看这次任务
                  </button>
                )}
                <button className="btn-link" aria-expanded={pack === (t.run_id ?? "")} onClick={() => { setPack(pack === (t.run_id ?? "") ? null : (t.run_id ?? "")); setPackNote(""); }}>
                  预览交付包
                </button>
              </td>
            </tr>,
            ...(pack === (t.run_id ?? "")
              ? [
                  (() => {
                    const p = deliveryPackage(t.rows);
                    return (
                      <tr key={`pack-${t.run_id ?? "none"}`} className="dl-pack">
                        <td colSpan={4}>
                          <div className="card dl-pack-card" role="region" aria-label="交付包">
                            <div className="card-title">交付包：能交出去 {p.ready.length} 份{p.held.length > 0 ? ` · 不随包 ${p.held.length} 份` : ""}</div>
                            {p.ready.length === 0 && <p className="muted">这次任务还没有能交出去的文件：对外的文件要先签发；内部稿不随包。</p>}
                            {p.ready.map((r: any) => (
                              <div key={r.artifact_version_id} className="dl-pack-row">
                                <b>{r.display}</b>
                                <span className="muted"> · 给{AUDIENCE_LABELS[r.audience] ?? r.audience} · 已签发{r.version > 1 ? ` · 第 ${r.version} 版` : ""}</span>
                              </div>
                            ))}
                            {p.held.map(({ row, reason }) => (
                              <div key={row.artifact_version_id} className="dl-pack-row muted">
                                {row.display} · {PACKAGE_REASON_TEXT[reason]}
                              </div>
                            ))}
                            {p.ready.length > 0 && (
                              <div className="card-actions">
                                <button
                                  className="btn-primary"
                                  onClick={() =>
                                    void (async () => {
                                      let n = 0;
                                      for (const r of p.ready) if (await download(r)) n += 1;
                                      setPackNote(n > 0 ? `已下载 ${n} 份，下载记录已写进本事项。发出前请再看一眼收件人与附件。` : "");
                                    })()
                                  }
                                >
                                  下载这 {p.ready.length} 份
                                </button>
                                {packNote && <span className="muted">{packNote}</span>}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })(),
                ]
              : []),
            ...t.rows.map((r: any) => (
            <tr key={r.artifact_version_id} className="row-link dl-in-task" onClick={() => nav(`/review/${r.artifact_version_id}`)}>
              <td title={r.filename}><b>{r.display}</b></td>
              <td><StatusPill r={r} /></td>
              <td title={fmtTime(r.created_at)}>{fmtWhen(r.created_at)}</td>
              <td className="dl-actions" onClick={(e) => e.stopPropagation()}>
                <button className="btn-link" onClick={() => void download(r)}>
                  {downloadPlan(r.filename).label}
                </button>
              </td>
            </tr>
            )),
          ])}
        </tbody>
      </table>
    </>
  );
}
