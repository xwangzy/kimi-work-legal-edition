/**
 * 成果（第 03 篇 §4.1：待复核、草稿、已签发；成果只是草稿，复核签发后才是成果）。
 * Z3 评审 #2：列表显示律师看得懂的标题（内容标题在本机还原代号；文件名只在悬停时显示），按事项分组；
 * 点任何一行都进入这份文件的详情（左预览、右签发前检查）；每行可直接下载，草稿行可提交复核。
 * 第 48 批：去掉表头与三层表格行，改为“事项标题 → 每次任务一张卡片 → 文件行”；页首一句话 + 搜索 + 状态页签（计数是徽标）。
 * 第 49 批：页首一句话说“等你处理的是什么”；同族文件共同前缀淡化、差异加粗；“第 N 版”合并原“版本记录（n）”。
 * 第 51 批：复核流程（草稿 → 待复核 → 已签发，有退回时多一段）本身就是筛选器；状态是带色点的文字；主交付物排第一。
 * 第 66 批（V40）：宽窗口左列表、右就地预览；窄窗口（< 1100px）点开仍直达复核页。
 * 第 67 批（V41 工作线 D）：文档工作区——
 * - 页头横跨两栏（标题 + 一句话 + 搜索）；下面左栏是列表、右栏是预览，两栏各自滚动、顶边与底边对齐；
 * - 复核流程收成列表栏顶上一条安静的分段筛选（全部 · 草稿 › 待复核 › 已签发，带份数，含义在悬停提示），不再占一整行大卡片；
 * - 事项是一行安静的分组标题（不再是带边框的卡片），任务是一行灰字（任务名 · 针对的文件 · 时间），文件行两行：短名 / 版本 · 时间；
 * - 名称去噪：同一次任务的“01-设备买卖合同（RC-XS-2025-118）（修订稿）/（清洁稿）……”显示成“修订稿”“清洁稿”，
 *   共同针对的文件在任务那一行说一次，和事项名重复的后缀不写（lib/deliverables.ts taskTitles）；完整名称在悬停与预览头；
 * - 上下键在文件之间移动（宽窗口同时换预览）；搜索、筛选后选中项不在列表里时自动换到第一份。
 */
import { Fragment, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, type Matter } from "../api.ts";
import { nav } from "../App.tsx";
import { AUDIENCE_LABELS, fileListName, fmtWhen } from "../lib/labels.ts";
import { deliveryPackage, fileCount, foldEarlierRuns, groupByTask, groupDeliverables, inFilter, isPrimaryFile, nameParts, PACKAGE_REASON_TEXT, splitTaskFiles, taskCountText, taskGroupLabel, taskPrimary, taskTitles, visibleStages, whenText, type DeliverableFilter } from "../lib/deliverables.ts";
import { FileRows, ProcessRows, type MenuItem } from "../components/ArtifactRow.tsx";
import { restoredPlain, restoreTokens } from "../lib/tokens.ts";
import { Icon } from "../components/Icons.tsx";
import { ListSkeleton, LoadError } from "../components/Loading.tsx";
import { DeliverablePreview, DeliverablePreviewEmpty, type PreviewRow } from "../components/DeliverablePreview.tsx";

type Row = any & { matter_id: string; matter_title: string; display: string };

/** 读一个事项的成果并在本机还原标题里的代号（还原结果只在渲染进程内存里）。 */
async function matterRows(m: Matter): Promise<Row[]> {
  const a = await api.listArtifacts(m.matter_id);
  const titles = a.artifacts.map((x: any) => `${x.title ?? ""}\n${x.filename ?? ""}`).join("\n");
  const map = titles.includes("〔") ? await restoreTokens(m.matter_id, titles).catch(() => new Map<string, string | null>()) : new Map<string, string | null>();
  return a.artifacts.map((x: any) => ({ ...x, matter_id: m.matter_id, matter_title: m.title, display: fileListName(x, (t) => restoredPlain(t, map)), save_name: restoredPlain(String(x.filename ?? ""), map) }));
}

/** 上下键在列表的文件行之间移动焦点（宽窗口同时换右侧预览）。 */
function moveInList(e: KeyboardEvent<HTMLElement>, select: boolean) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-dl-nav]")];
  if (rows.length === 0) return;
  const at = rows.findIndex((r) => r === document.activeElement || r.contains(document.activeElement));
  const next = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
  if (!next) return;
  e.preventDefault();
  next.focus();
  if (select) next.click();
}

export function DeliverablesPage() {
  const [matters, setMatters] = useState<Matter[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  /** 事项列表都没读到（整页失败）。 */
  const [loadErr, setLoadErr] = useState("");
  /** 有几个事项的成果没读到（其余照常显示，页首如实说明）。 */
  const [missed, setMissed] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  // 第 66 批（V40 P0-3）：右侧就地预览——宽窗口点一行在右边看内容与版本；窄窗口（< 1100px）仍直接进复核页
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const wide = useWide();
  const load = () => {
    setLoadErr("");
    return api
      .listMatters()
      .then(async (r) => {
        setMatters(r.matters);
        // 并行读各事项（原来逐个等，事项多时首屏要等几秒）；单个事项失败不拖垮整页，计数后如实提示
        const got = await Promise.allSettled(r.matters.slice(0, 50).map(matterRows));
        const all = got.flatMap((g) => (g.status === "fulfilled" ? g.value : []));
        setMissed(got.filter((g) => g.status === "rejected").length);
        all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        setRows(all);
      })
      .catch((e) => {
        setLoadErr((e as Error).message);
        setRows(null);
      });
  };
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
        tasks: groupByTask(g.rows).map((t) => {
          const split = splitTaskFiles(t.rows, { primary: taskPrimary(t) });
          // 第 67 批：短名与这次任务共同针对的文件（按整次任务算，筛选前后不变）
          return { ...t, split, titles: taskTitles(split.files.map((e) => String(e.latest.display)), g.matter_title) };
        }),
      })),
    [visible],
  );
  const count = (k: Filter) => groups.reduce((n, g) => n + g.tasks.reduce((m, t) => m + t.split.files.filter((e) => !e.replaced && inFilter(e.latest.status, k)).length, 0), 0);
  const counts = { draft: count("draft"), pending_review: count("pending_review"), rejected: count("rejected"), approved: count("approved") };
  // 第 67 批第三轮（独立评审 #1）：筛选就是筛选——缺省“全部”，不再自动跳到某一段；页首不再重复“N 份草稿还没复核”（与“草稿 N”重复）
  const choose = (k: Filter) => setFilter(k);
  const pick = <E extends { latest: { status: string } }>(es: E[]) => es.filter((e) => inFilter(e.latest.status, filter));
  const shownGroups = groups
    .map((g) => ({ ...g, tasks: g.tasks.map((t) => ({ ...t, files: pick(t.split.files), process: filter === "all" ? t.split.process : pick(t.split.process) })).filter((t) => t.files.length + t.process.length + (filter === "all" ? t.split.earlier.length : 0) > 0) }))
    .filter((g) => g.tasks.length > 0);
  // 选中那一版所在的文件（各版本）与任务，供右侧预览切换版本、回到任务
  const picked = useMemo(() => {
    if (!selectedId) return null;
    for (const g of groups)
      for (const t of g.tasks)
        for (const e of [...t.split.files, ...t.split.process, ...t.split.earlier]) {
          const all = [e.latest, ...e.older];
          const hit = all.find((x: any) => x.artifact_version_id === selectedId);
          if (hit) return { row: hit as PreviewRow, versions: all as PreviewRow[], task: taskGroupLabel(t, (iso) => whenText(fmtWhen(iso))) };
        }
    return null;
  }, [selectedId, groups]);
  // 宽窗口且有成果时是“列表 + 预览”工作区
  const ws = wide && rows !== null && rows.length > 0;
  const open = (r: any) => (wide ? setSelectedId(r.artifact_version_id) : nav(`/review/${r.artifact_version_id}`));
  // 列表里现在能看到的各版本（筛选、搜索之后）；选中的不在里面时换到第一份，列表空了就清空选中
  const shownIds = shownGroups.flatMap((g) => g.tasks.flatMap((t) => [...t.files, ...t.process, ...(filter === "all" ? t.split.earlier : [])].flatMap((e) => [e.latest, ...e.older].map((x: any) => String(x.artifact_version_id)))));
  const firstShown = shownGroups[0]?.tasks.find((t) => t.files.length > 0)?.files[0]?.latest?.artifact_version_id ?? shownIds[0] ?? null;
  const shownKey = shownIds.join(",");
  useEffect(() => {
    if (!ws) return;
    if (selectedId && shownIds.includes(selectedId)) return;
    setSelectedId(firstShown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, shownKey]);
  const download = async (r: any) => {
    setErr("");
    setNote("");
    setDownloadingId(r.artifact_version_id);
    try {
      const saved = await api.downloadArtifact(r.artifact_version_id, r.save_name ?? r.filename);
      if (!saved) return;
      await api.deliver({ artifact_version_id: r.artifact_version_id, action: "download" });
      setNote(`已保存「${r.display}」（真实名称已还原，下载记在事项日志里）。`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDownloadingId(null);
    }
  };
  const submit = async (r: any) => {
    setBusyId(r.artifact_version_id);
    setErr("");
    try {
      await api.submitReview(r.artifact_version_id);
      nav(`/review/${r.artifact_version_id}`);
      void load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };
  // 行尾“更多”：复核页（宽窗口时点行是预览，复核页从这里去）、这次任务
  const rowMenu = (r: any): MenuItem[] => [
    ...(wide ? [{ label: r.status === "approved" ? "查看签发记录" : "打开复核页", onSelect: () => nav(`/review/${r.artifact_version_id}`) }] : []),
    ...(r.run_id ? [{ label: "看这次任务", onSelect: () => nav(`/run/${r.run_id}/${r.matter_id}`) }] : []),
    { label: "打开事项", onSelect: () => nav(`/matter/${r.matter_id}`) },
  ];
  const stages = visibleStages(counts);
  const total = count("all");
  const emptyText = q ? `没有找到“${query.trim()}”` : EMPTY_TEXT[filter];
  // 按复核状态筛选（第 67 批收成一条安静的分段；第三轮去掉流程箭头，只当筛选标签用）：全部 | 草稿 · 待复核 · 已签发（· 已退回）
  const flow = (
    <div className="dl-flow" role="tablist" aria-label="按复核流程筛选">
      <button role="tab" aria-selected={filter === "all"} className={`dl-flow-step dl-flow-all${filter === "all" ? " on" : ""}`} onClick={() => choose("all")}>
        <span className="dl-flow-label">全部</span>
        <span className="dl-flow-n">{rows === null ? "–" : total}</span>
      </button>
      <span className="dl-flow-div" aria-hidden="true" />
      {stages.map((s) => (
        <span key={s.key} className="dl-flow-seg">
          <button role="tab" aria-selected={filter === s.key} title={`${s.label}：${s.note}`} className={`dl-flow-step dl-flow-${s.key}${filter === s.key ? " on" : ""}${rows !== null && counts[s.key] === 0 ? " zero" : ""}`} onClick={() => choose(s.key)}>
            <span className="dl-flow-label">{s.label}</span>
            <span className="dl-flow-n">{rows === null ? "–" : counts[s.key]}</span>
          </button>
        </span>
      ))}
    </div>
  );
  return (
    <main className={`main dlws-main${ws ? " is-ws" : ""}`}>
      <div className={`main-wide dl-page${ws ? " dl-ws" : ""}`}>
        <div className="dl-head">
          <h1 className="page-title">成果</h1>
          <label className="dl-search">
            <span className="dl-search-icon" aria-hidden="true">{Icon.search()}</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} placeholder="搜索文件或事项" aria-label="搜索文件或事项" />
            {query && (
              <button className="icon-btn" aria-label="清除搜索" onClick={() => setQuery("")}>
                {Icon.x()}
              </button>
            )}
          </label>
        </div>
        {err && <div className="banner banner-red">{err}</div>}
        {note && <div className="banner banner-gray">{note}</div>}
        {missed > 0 && <div className="banner banner-orange">有 {missed} 个事项的成果这次没有读到，下面没有列出它们。稍后回到本页会重新读取。</div>}
        {/* 搜索、筛选后一份都没有：收起预览栏，列表与空状态占满（第三轮，独立评审 #3） */}
        <div className={`dl-split${ws && shownGroups.length === 0 ? " dl-split-empty" : ""}`}>
          <div className="dl-list-col">
            {rows !== null && rows.length > 0 && <div className="dl-toolbar">{flow}</div>}
            <div className="dl-list" onKeyDown={(e) => moveInList(e, wide)}>
              {rows === null && !loadErr && <ListSkeleton cards={2} rows={3} label="正在载入成果" />}
              {loadErr && <LoadError what="成果" message={loadErr} onRetry={() => void load()} />}
              {rows !== null && shownGroups.length === 0 && (
                <div className="dl-empty">
                  <span className="dl-empty-icon" aria-hidden="true">{q ? Icon.search() : Icon.fileCheck()}</span>
                  <div className="dl-empty-title">{emptyText}</div>
                  {q && (
                    <button className="btn-link" onClick={() => setQuery("")}>
                      清除搜索
                    </button>
                  )}
                  {!q && filter !== "all" && total > 0 && (
                    <button className="btn-link" onClick={() => choose("all")}>
                      看全部 {total} 份 →
                    </button>
                  )}
                  {!q && total === 0 && (
                    <button className="btn-ghost btn-sm" onClick={() => nav("/")}>
                      去新建任务
                    </button>
                  )}
                </div>
              )}
              {shownGroups.map((g) => {
                const files = g.tasks.reduce((n, t) => n + fileCount(t.files), 0);
                return (
                  <section key={g.matter_id} className="dl-matter" aria-label={g.matter_title}>
                    {/* 事项是一行安静的分组标题（第 67 批：不再套带边框的卡片），点开去事项 */}
                    <div className="dl-matter-head">
                      <button className="dl-matter-title" onClick={() => nav(`/matter/${g.matter_id}`)} title={`打开事项：${g.matter_title}`}>
                        <span className="dl-matter-name">{g.matter_title}</span>
                        <span className="dl-matter-go" aria-hidden="true">{Icon.right()}</span>
                      </button>
                      {files > 0 && <span className="dl-matter-meta">{files} 份</span>}
                    </div>
                    {/* 同一种任务跑了几次：最新一次照常列出，更早的收成一行（第三轮，独立评审 #2） */}
                    {foldEarlierRuns(g.tasks, (t) => (t.run_id ? taskGroupLabel({ ...t, started_at: null }, () => "") : ""), (t) => t.files.map((e) => t.titles.names.get(String(e.latest.display))?.title ?? String(e.latest.display))).map(({ task, earlier, renewed }) => {
                      const renderTask = (t: typeof task) => (
                        <div key={t.run_id ?? "none"} className="dl-task">
                          <TaskHead
                            label={taskGroupLabel(t, (iso) => whenText(fmtWhen(iso)))}
                            subject={t.titles.shared}
                            // 组头写这次任务一共几份文件（复核 RB16B-11：状态筛选之后只显示一部分时说清）
                            count={t.split.files.length > 0 && fileCount(t.files) < fileCount(t.split.files) ? taskCountText(fileCount(t.files), fileCount(t.split.files)) : null}
                          >
                            {t.run_id && (
                              <button className="btn-link" onClick={() => nav(`/run/${t.run_id}/${g.matter_id}`)}>
                                看这次任务
                              </button>
                            )}
                          </TaskHead>
                          {t.files.length > 0 && (
                            <div className="dl-rows" role="list">
                              {(() => {
                                const parts = nameParts(t.files.map((e) => String(e.latest.display)));
                                const primary = taskPrimary(t);
                                return t.files.map((e, i) => (
                                  <FileRows
                                    key={e.key}
                                    entry={e}
                                    parts={parts.get(String(e.latest.display))}
                                    name={t.titles.names.get(String(e.latest.display))}
                                    primary={i === 0 && isPrimaryFile(String(e.latest.filename ?? ""), primary)}
                                    showStatus={filter === "all"}
                                    onOpen={open}
                                    onDownload={(r) => void download(r)}
                                    downloadingId={downloadingId}
                                    onSubmit={(r) => void submit(r)}
                                    busyId={busyId}
                                    selectedId={wide ? selectedId : null}
                                    versionsInline={!wide}
                                    menu={rowMenu}
                                  />
                                ));
                              })()}
                            </div>
                          )}
                          <ProcessRows entries={t.process} onDownload={(r) => void download(r)} onOpen={wide ? open : undefined} selectedId={wide ? selectedId : null} downloadingId={downloadingId} />
                          {/* 重新运行前那一次留下的文件（第 44 批）：按状态筛选时不列（它们不是草稿也不是待复核），“全部”时收在最后 */}
                          {filter === "all" && <ProcessRows entries={t.split.earlier} onDownload={(r) => void download(r)} earlier onOpen={wide ? open : undefined} selectedId={wide ? selectedId : null} downloadingId={downloadingId} />}
                        </div>
                      );
                      return (
                        <Fragment key={task.run_id ?? "none"}>
                          {renderTask(task)}
                          {earlier.length > 0 && (
                            <EarlierRuns runs={earlier.length} files={earlier.reduce((n, t) => n + fileCount(t.files), 0)} renewed={renewed} defaultOpen={!!selectedId && earlier.some((t) => [...t.files, ...t.process].some((e) => [e.latest, ...e.older].some((x: any) => x.artifact_version_id === selectedId)))}>
                              {earlier.map(renderTask)}
                            </EarlierRuns>
                          )}
                        </Fragment>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          </div>
          {ws &&
            shownGroups.length > 0 &&
            (picked ? (
              <DeliverablePreview
                key={picked.row.artifact_version_id}
                row={picked.row}
                versions={picked.versions}
                taskLabel={picked.task}
                onDownload={(r) => void download(r)}
                onSubmit={(r) => void submit(r)}
                busy={busyId === picked.row.artifact_version_id}
                downloading={downloadingId === picked.row.artifact_version_id}
              />
            ) : (
              <DeliverablePreviewEmpty text="在左侧选择文件查看" />
            ))}
        </div>
      </div>
    </main>
  );
}

/** 窗口够宽（≥ 1100px）才在成果页右侧预览；窄了仍点开进复核页。 */
function useWide(): boolean {
  const q = "(min-width: 1100px)";
  const [w, setW] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(q).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(q);
    const on = () => setW(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return w;
}

type Filter = DeliverableFilter;
const EMPTY_TEXT: Record<Filter, string> = {
  draft: "没有还没复核的草稿",
  pending_review: "没有等签发的文件",
  rejected: "没有被退回的文件",
  approved: "还没有签发的文件",
  all: "还没有任何成果。任务完成后，生成的文件会出现在这里",
};

/**
 * 任务那一行（第 67 批：一行灰字，不是卡片头）：任务名 · 这次共同针对的文件 · 时间 · 份数，入口悬停出现。
 * taskGroupLabel 形如“起草起诉状 · 11月9日 21:46”。
 */
function TaskHead({ label, count, subject = "", children }: { label: string; count: string | null; subject?: string; children?: ReactNode }) {
  const i = label.lastIndexOf(" · ");
  const name = i > 0 ? label.slice(0, i) : label;
  const when = i > 0 ? label.slice(i + 3) : "";
  return (
    <div className="dl-task-head">
      <span className="dl-task-name">{name}</span>
      {subject && (
        <span className="dl-task-subject" title={`这次任务针对：${subject}`}>
          {subject}
        </span>
      )}
      <span className="dl-task-meta">{[when, count].filter(Boolean).join(" · ")}</span>
      <span className="dl-task-actions">{children}</span>
    </div>
  );
}

/** 更早几次运行（第三轮）：默认收起的一行“更早 N 次运行（M 份）· 已有新版”，展开是那几次的任务行与文件。选中的文件在里面时默认展开。 */
function EarlierRuns({ runs, files, renewed, defaultOpen, children }: { runs: number; files: number; renewed: boolean; defaultOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`dl-earlier${open ? " open" : ""}`}>
      <button className="dl-proc-toggle dl-earlier-toggle" aria-expanded={open} title="同一种任务后来又运行过，最新一次在上面；更早的文件仍在，没有删除" onClick={() => setOpen((v) => !v)}>
        <span className="dl-proc-chev" aria-hidden="true">{Icon.chevron()}</span>
        更早 {runs} 次运行（{files} 份）
        {renewed && <span className="dl-earlier-note">· 已有新版</span>}
      </button>
      {open && <div className="dl-earlier-body">{children}</div>}
    </div>
  );
}

/** 事项页“成果”标签（Z3 评审 #10）：本事项的成果，与成果页同样的标题、直达与下载。 */
export function MatterDeliverables({ matterId }: { matterId: string }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  // 预览交付包（v9.4 第 21 批）：展开的是哪一次任务
  const [pack, setPack] = useState<string | null>(null);
  const [packNote, setPackNote] = useState("");
  const download = (r: any) => {
    setDownloadingId(r.artifact_version_id);
    return api
      .downloadArtifact(r.artifact_version_id, r.save_name ?? r.filename)
      .then((saved) => (saved ? api.deliver({ artifact_version_id: r.artifact_version_id, action: "download" }).then(() => true) : false))
      .catch((e) => {
        setErr((e as Error).message);
        return false;
      })
      .finally(() => setDownloadingId(null));
  };
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setLoadErr("");
    api
      .listArtifacts(matterId)
      .then(async (a) => {
        const titles = a.artifacts.map((x: any) => `${x.title ?? ""}\n${x.filename ?? ""}`).join("\n");
        const map = titles.includes("〔") ? await restoreTokens(matterId, titles).catch(() => new Map<string, string | null>()) : new Map<string, string | null>();
        setRows([...a.artifacts].sort((x: any, y: any) => String(y.created_at).localeCompare(String(x.created_at))).map((x: any) => ({ ...x, display: fileListName(x, (t) => restoredPlain(t, map)), save_name: restoredPlain(String(x.filename ?? ""), map) })));
      })
      .catch((e) => setLoadErr((e as Error).message));
  }, [matterId, reload]);
  if (loadErr) return <LoadError what="本事项的成果" message={loadErr} onRetry={() => setReload((n) => n + 1)} />;
  if (rows === null) return <ListSkeleton rows={3} label="正在载入本事项的成果" />;
  if (rows.length === 0) return <p className="muted">本事项还没有成果。任务完成后，生成的文件会出现在这里。</p>;
  return (
    <div className="dl-page dl-in-matter">
      {err && <div className="banner banner-red">{err}</div>}
      {groupByTask(rows).map((t) => {
        const sp = splitTaskFiles(t.rows, { primary: taskPrimary(t) });
        const titles = taskTitles(sp.files.map((e) => String(e.latest.display)));
        const packOpen = pack === (t.run_id ?? "");
        const p = packOpen ? deliveryPackage(t.rows) : null;
        return (
          <div key={t.run_id ?? "none"} className="dl-task">
            <TaskHead label={taskGroupLabel(t, (iso) => whenText(fmtWhen(iso)))} subject={titles.shared} count={fileCount(sp.files) > 0 ? `${fileCount(sp.files)} 份文件` : null}>
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
            {/* V18 A2：每份文件一行（最新版），旧版在“第 N 版”里展开；答复摘要与复核意见收进“过程文件” */}
            {sp.files.length > 0 && (
              <div className="dl-rows" role="list">
                {(() => {
                  const parts = nameParts(sp.files.map((e) => String(e.latest.display)));
                  const primary = taskPrimary(t);
                  return sp.files.map((e, i) => (
                    <FileRows key={e.key} entry={e} parts={parts.get(String(e.latest.display))} name={titles.names.get(String(e.latest.display))} primary={i === 0 && isPrimaryFile(String(e.latest.filename ?? ""), primary)} showStatus onOpen={(r) => nav(`/review/${r.artifact_version_id}`)} onDownload={(r) => void download(r)} downloadingId={downloadingId} />
                  ));
                })()}
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
