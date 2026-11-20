/**
 * 成果（第 03 篇 §4.1：待复核、草稿、已签发；成果只是草稿，复核签发后才是成果）。
 * Z3 评审 #2：列表显示律师看得懂的标题（内容标题在本机还原代号；文件名只在悬停时显示），按事项分组；
 * 点任何一行都进入这份文件的详情（左预览、右签发前检查）；每行可直接下载，草稿行可提交复核。
 * 第 48 批：去掉表头与三层表格行，改为“事项标题 → 每次任务一张卡片 → 文件行”；页首一句话 + 搜索 + 状态页签（计数是徽标）；
 * 行内操作收为下载图标与悬停出现的“提交复核”，一屏不再是几十个描边按钮。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Matter } from "../api.ts";
import { nav } from "../App.tsx";
import { AUDIENCE_LABELS, fileListName, fmtWhen } from "../lib/labels.ts";
import { deliveryPackage, fileCount, groupByTask, groupDeliverables, PACKAGE_REASON_TEXT, splitTaskFiles, taskCountText, taskGroupLabel, taskPrimary } from "../lib/deliverables.ts";
import { FileRows, ProcessRows } from "../components/ArtifactRow.tsx";
import { restoredPlain, restoreTokens } from "../lib/tokens.ts";
import { Icon } from "../components/Icons.tsx";

export function DeliverablesPage() {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [rows, setRows] = useState<(any & { matter_title: string; display: string })[] | null>(null);
  const [filter, setFilter] = useState<Filter>("pending_review");
  const [query, setQuery] = useState("");
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
          const titles = a.artifacts.map((x: any) => `${x.title ?? ""}\n${x.filename ?? ""}`).join("\n");
          const map = titles.includes("〔") ? await restoreTokens(m.matter_id, titles).catch(() => new Map<string, string | null>()) : new Map<string, string | null>();
          for (const x of a.artifacts) all.push({ ...x, matter_id: m.matter_id, matter_title: m.title, display: fileListName(x, (t) => restoredPlain(t, map)), save_name: restoredPlain(String(x.filename ?? ""), map) });
        }
        all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        setRows(all);
      })
      .catch(() => setRows([]));
  useEffect(() => {
    void load();
  }, []);
  // 搜索（第 48 批）：按文件名或事项名筛，在本机内存里做（名称已还原）
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => (rows ?? []).filter((r) => !q || String(r.display).toLowerCase().includes(q) || String(r.matter_title).toLowerCase().includes(q)), [rows, q]);
  // V18 A2：事项 → 一次任务 → 每份文件（最新版 + 旧版）与过程文件；计数按文件，不按版本
  const groups = useMemo(
    () =>
      groupDeliverables(visible).map((g) => ({
        ...g,
        tasks: groupByTask(g.rows).map((t) => ({ ...t, split: splitTaskFiles(t.rows, { primary: taskPrimary(t) }) })),
      })),
    [visible],
  );
  const count = (k: Filter) => groups.reduce((n, g) => n + g.tasks.reduce((m, t) => m + fileCount(t.split.files, k === "all" ? undefined : k), 0), 0);
  // 律师没点过分组时，缺省停在第一个有文件的分组（待复核 → 草稿 → 已签发）
  useEffect(() => {
    if (touchedRef.current || !rows || rows.length === 0) return;
    const first = (["pending_review", "draft", "approved"] as const).find((k) => count(k) > 0);
    if (first) setFilter(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);
  const pick = <E extends { latest: { status: string } }>(es: E[]) => es.filter((e) => filter === "all" || e.latest.status === filter);
  const shownGroups = groups
    .map((g) => ({ ...g, tasks: g.tasks.map((t) => ({ ...t, files: pick(t.split.files), process: pick(t.split.process) })).filter((t) => t.files.length + t.process.length + (filter === "all" ? t.split.earlier.length : 0) > 0) }))
    .filter((g) => g.tasks.length > 0);
  const download = async (r: any) => {
    setErr("");
    setNote("");
    try {
      const saved = await api.downloadArtifact(r.artifact_version_id, r.save_name ?? r.filename);
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
      <div className="main-wide dl-page">
        <div className="dl-head">
          <div>
            <h1 className="page-title">成果</h1>
            {/* 第 48 批：页首只留一句；“版本记录”“过程文件”在列表里自己说明 */}
            <p className="dl-sub">AI 生成的文件都是草稿，经你复核签发后才能对外。{matters.length > 50 ? "（只列最近 50 个事项）" : ""}</p>
          </div>
          <label className="dl-search">
            <span className="dl-search-icon" aria-hidden="true">{Icon.search()}</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索文件或事项" aria-label="搜索文件或事项" />
            {query && (
              <button className="icon-btn" aria-label="清除搜索" onClick={() => setQuery("")}>
                {Icon.x()}
              </button>
            )}
          </label>
        </div>
        <div className="dl-tabs" role="tablist" aria-label="按状态">
          {FILTERS.map(([k, l]) => (
            <button
              key={k}
              role="tab"
              aria-selected={filter === k}
              className={`dl-tab${filter === k ? " on" : ""}`}
              onClick={() => {
                touchedRef.current = true;
                setFilter(k);
              }}
            >
              {l}
              <span className="dl-tab-n">{count(k)}</span>
            </button>
          ))}
        </div>
        {err && <div className="banner banner-red">{err}</div>}
        {note && <div className="banner banner-gray">{note}</div>}
        {rows === null && <p className="muted">正在载入…</p>}
        {rows !== null && shownGroups.length === 0 && (
          <div className="dl-empty">
            <span className="dl-empty-icon" aria-hidden="true">{Icon.fileCheck()}</span>
            <div className="dl-empty-title">{q ? `没有找到“${query.trim()}”` : EMPTY_TEXT[filter]}</div>
            {!q && filter !== "draft" && filter !== "all" && count("draft") > 0 && (
              <button className="btn-link" onClick={() => setFilter("draft")}>
                草稿里有 {count("draft")} 份 →
              </button>
            )}
          </div>
        )}
        {shownGroups.map((g) => (
          <section key={g.matter_id} className="dl-matter" aria-label={g.matter_title}>
            <div className="dl-matter-head">
              <button className="dl-matter-title" onClick={() => nav(`/matter/${g.matter_id}`)}>
                {g.matter_title}
              </button>
              <span className="dl-matter-n">{g.tasks.reduce((n, t) => n + fileCount(t.files), 0)} 份文件</span>
            </div>
            {/* 事项下再按“一次任务”分组（Astra M-3）：这次要交给客户的那几份放在一张卡片里 */}
            {g.tasks.map((t) => (
              <div key={t.run_id ?? "none"} className="dl-task">
                <TaskHead
                  label={taskGroupLabel(t, (iso) => fmtWhen(iso))}
                  // 组头写这次任务一共几份文件（复核 RB16B-11：状态筛选之后只显示一部分时说清）
                  count={t.split.files.length > 0 ? taskCountText(fileCount(t.files), fileCount(t.split.files)) : null}
                >
                  {t.run_id && (
                    <button className="btn-link" onClick={() => nav(`/run/${t.run_id}/${g.matter_id}`)}>
                      看这次任务
                    </button>
                  )}
                </TaskHead>
                {t.files.length > 0 && (
                  <div className="dl-rows" role="list">
                    {t.files.map((e) => (
                      <FileRows key={e.key} entry={e} showStatus={filter === "all"} onOpen={(r) => nav(`/review/${r.artifact_version_id}`)} onDownload={(r) => void download(r)} onSubmit={(r) => void submit(r)} busyId={busyId} />
                    ))}
                  </div>
                )}
                <ProcessRows entries={t.process} onDownload={(r) => void download(r)} />
                {/* 重新运行前那一次留下的文件（第 44 批）：按状态筛选时不列（它们不是草稿也不是待复核），“全部”时收在最后 */}
                {filter === "all" && <ProcessRows entries={t.split.earlier} onDownload={(r) => void download(r)} earlier />}
              </div>
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}

type Filter = "pending_review" | "draft" | "approved" | "all";
const FILTERS: [Filter, string][] = [
  ["pending_review", "待复核"],
  ["draft", "草稿"],
  ["approved", "已签发"],
  ["all", "全部"],
];
const EMPTY_TEXT: Record<Filter, string> = { pending_review: "没有待复核的文件", draft: "没有草稿", approved: "还没有签发的文件", all: "还没有任何成果。任务完成后，生成的文件会出现在这里" };

/** 任务卡片的头：任务名 + 时间 + 份数，右侧放入口。taskGroupLabel 形如“起草起诉状 · 11月9日 21:46”。 */
function TaskHead({ label, count, children }: { label: string; count: string | null; children?: ReactNode }) {
  const i = label.lastIndexOf(" · ");
  const name = i > 0 ? label.slice(0, i) : label;
  const when = i > 0 ? label.slice(i + 3) : "";
  return (
    <div className="dl-task-head">
      <span className="dl-task-name">{name}</span>
      <span className="dl-task-meta">{[when, count].filter(Boolean).join(" · ")}</span>
      <span className="dl-task-actions">{children}</span>
    </div>
  );
}

/** 事项页“成果”标签（Z3 评审 #10）：本事项的成果，与成果页同样的标题、直达与下载。 */
export function MatterDeliverables({ matterId }: { matterId: string }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  // 预览交付包（v9.4 第 21 批）：展开的是哪一次任务
  const [pack, setPack] = useState<string | null>(null);
  const [packNote, setPackNote] = useState("");
  const download = (r: any) =>
    api
      .downloadArtifact(r.artifact_version_id, r.save_name ?? r.filename)
      .then((saved) => (saved ? api.deliver({ artifact_version_id: r.artifact_version_id, action: "download" }).then(() => true) : false))
      .catch((e) => {
        setErr((e as Error).message);
        return false;
      });
  useEffect(() => {
    api
      .listArtifacts(matterId)
      .then(async (a) => {
        const titles = a.artifacts.map((x: any) => `${x.title ?? ""}\n${x.filename ?? ""}`).join("\n");
        const map = titles.includes("〔") ? await restoreTokens(matterId, titles).catch(() => new Map<string, string | null>()) : new Map<string, string | null>();
        setRows([...a.artifacts].sort((x: any, y: any) => String(y.created_at).localeCompare(String(x.created_at))).map((x: any) => ({ ...x, display: fileListName(x, (t) => restoredPlain(t, map)), save_name: restoredPlain(String(x.filename ?? ""), map) })));
      })
      .catch(() => setRows([]));
  }, [matterId]);
  if (rows === null) return <p className="muted">正在载入…</p>;
  if (rows.length === 0) return <p className="muted">本事项还没有成果。任务完成后，生成的文件会出现在这里。</p>;
  return (
    <div className="dl-page dl-in-matter">
      {err && <div className="banner banner-red">{err}</div>}
      {groupByTask(rows).map((t) => {
        const sp = splitTaskFiles(t.rows, { primary: taskPrimary(t) });
        const packOpen = pack === (t.run_id ?? "");
        const p = packOpen ? deliveryPackage(t.rows) : null;
        return (
          <div key={t.run_id ?? "none"} className="dl-task">
            <TaskHead label={taskGroupLabel(t, (iso) => fmtWhen(iso))} count={fileCount(splitTaskFiles(t.rows).files) > 0 ? `${fileCount(splitTaskFiles(t.rows).files)} 份文件` : null}>
              {t.run_id && (
                <button className="btn-link" onClick={() => nav(`/run/${t.run_id}/${matterId}`)}>
                  看这次任务
                </button>
              )}
              <button
                className="btn-link"
                aria-expanded={packOpen}
                onClick={() => {
                  setPack(packOpen ? null : (t.run_id ?? ""));
                  setPackNote("");
                }}
              >
                预览交付包
              </button>
            </TaskHead>
            {p && (
              <div className="dl-pack-card" role="region" aria-label="交付包">
                <div className="dl-pack-title">交付包：能交出去 {p.ready.length} 份{p.held.length > 0 ? ` · 不随包 ${p.held.length} 份` : ""}</div>
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
                      className="btn-primary btn-sm"
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
            )}
            {/* V18 A2：每份文件一行（最新版），旧版在“版本记录”；答复摘要与复核意见收进“过程文件” */}
            {sp.files.length > 0 && (
              <div className="dl-rows" role="list">
                {sp.files.map((e) => (
                  <FileRows key={e.key} entry={e} showStatus onOpen={(r) => nav(`/review/${r.artifact_version_id}`)} onDownload={(r) => void download(r)} />
                ))}
              </div>
            )}
            <ProcessRows entries={sp.process} onDownload={(r) => void download(r)} />
            <ProcessRows entries={sp.earlier} onDownload={(r) => void download(r)} earlier />
          </div>
        );
      })}
    </div>
  );
}
