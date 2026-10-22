/**
 * 事项“材料 → 表格审阅”（v9.4 第 19 批 C-01；评审 C1 §3.3）：行 = 材料，列 = 问题，格 = 带原文出处的答案 + 复核状态。
 * 选模板（证据清单 / 合同尽调摘要 / 合同台账）与材料建表 → “让助手填表”（tabular-review 方法，表编号作方法参数）→
 * 逐格核：点格子看引文，确认 / 改值（原 AI 值保留）/ 撤回；已核、已改的格子助手重填时不覆盖 → 导出 Excel（未核的标“待核”）。
 * 格子文字是事项令牌形态，按事项令牌表还原显示；律师改的值为原文。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { restoredPlain, restoreTokens } from "../lib/tokens.ts";
import { CELL_STATE_CLASS, CELL_STATE_TEXT, cellText, columnApplies, COLUMN_FORMATS, draftLabel, formatProblem, isOpen, nextOpenCell, sortDocs, tableCounts, whenText, type CellView, type TableColumnView, type TableView } from "../lib/table-review.ts";
import { notifyDataChanged } from "../lib/events.ts";
import { Select } from "./Select.tsx";
import { ConfirmButton } from "./ConfirmButton.tsx";

interface Props {
  matterId: string;
  docs: { document_version_id: string; filename: string; quarantined_at?: string | null }[];
  readOnly: boolean;
  /** 让助手填表：上层按方法 tabular-review、表编号作方法参数、表里的材料发起任务（先估价确认）。 */
  onFill: (table: TableView) => void;
  /** 问这张表（v9.4 第 21 批，C1 §3.3 跨表对话）：上层按方法 tabular-review、mode=问表发起任务（先估价确认），只依据表里的格子回答。 */
  onAsk?: (table: TableView, question: string) => void;
  /** 导出后通知上层刷新交付件。 */
  onExported?: () => void;
  /** 打开时选中这张表（待核清单点进来，v9.4 第 21 批）。 */
  initialTable?: string | null;
}

type Template = { id: string; title: string; line: string; columns: TableColumnView[] };

export function TableReview({ matterId, docs, readOnly, onFill, onAsk, onExported, initialTable }: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tables, setTables] = useState<TableView[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [grid, setGrid] = useState<{ table: TableView; cells: CellView[]; docs: { document_version_id: string; filename: string }[] } | null>(null);
  const [map, setMap] = useState<Map<string, string | null>>(new Map());
  const [creating, setCreating] = useState<{ template: string; columns: string[]; docs: string[] } | null>(null);
  const [picked, setPicked] = useState<{ doc: string; col: string } | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  // v9.4 第 20 批（C1 §3.3）：按列排序、复核模式键盘、格子看原文前后、自建列、台账设提醒
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [ctx, setCtx] = useState<{ cell: string; located: boolean; before: string; quote: string; after: string } | null>(null);
  const [newCol, setNewCol] = useState<{ label: string; hint: string; format: TableColumnView["format"]; options: string; whenCol: string; whenEq: string } | null>(null);
  const [ask, setAsk] = useState<string | null>(null);
  const [cands, setCands] = useState<{ document_version_id: string; filename: string; column: string; label: string; date: string | null; verified: boolean; note: string; pick: boolean; due: string }[] | null>(null);

  const loadTables = useCallback(async () => {
    const r = await api.tables(matterId);
    setTables(r.tables);
    setCurrent((c) => c ?? (initialTable && r.tables.some((t) => t.table_id === initialTable) ? initialTable : null) ?? r.tables[0]?.table_id ?? null);
  }, [matterId, initialTable]);
  const loadGrid = useCallback(async () => {
    if (!current) return setGrid(null);
    const g = await api.table(matterId, current);
    setGrid(g);
    const all = g.cells.flatMap((c) => [c.value ?? "", c.quote ?? "", c.note ?? ""]).join("\n");
    if (all.includes("〔")) setMap(await restoreTokens(matterId, all));
  }, [matterId, current]);
  useEffect(() => {
    void api.tableTemplates().then((r) => setTemplates(r.templates)).catch(() => {});
    void loadTables().catch((e) => setMsg({ tone: "err", text: (e as Error).message }));
  }, [loadTables]);
  useEffect(() => {
    void loadGrid().catch((e) => setMsg({ tone: "err", text: (e as Error).message }));
  }, [loadGrid]);

  const plain = useCallback((s: string | null) => (s ? restoredPlain(s, map) : ""), [map]);
  const cellAt = useMemo(() => new Map((grid?.cells ?? []).map((c) => [`${c.document_version_id}\u0000${c.col_key}`, c])), [grid]);
  // 条件列（v9.4 第 21 批）：条件不满足的格子显示“不适用”，不算未核
  const notApplicable = (doc: string, col: TableColumnView) => !!col.when && columnApplies(col, cellAt.get(`${doc}\u0000${col.when.column}`)) === "no";
  const openAt = (doc: string, col: TableColumnView) => !notApplicable(doc, col) && isOpen(cellAt.get(`${doc}\u0000${col.key}`));
  const condCols = (grid?.table.columns ?? []).filter((c) => (c.format === "yesno" || c.format === "choice") && !c.when);
  const usable = docs.filter((d) => !d.quarantined_at);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await f();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const startCreate = () => {
    const t = templates[0];
    if (t) setCreating({ template: t.id, columns: t.columns.map((c) => c.key), docs: usable.map((d) => d.document_version_id) });
  };
  const create = () =>
    run(async () => {
      if (!creating) return;
      const { table } = await api.createTable(matterId, { template: creating.template, columns: creating.columns, document_version_ids: creating.docs });
      setCreating(null);
      setCurrent(table.table_id);
      await loadTables();
    });
  const decide = (body: Parameters<typeof api.decideCell>[2]) =>
    run(async () => {
      if (!grid) return;
      // 格子在你打开后被助手重填过（复核 Q2-05）：内核拒绝，这里刷新出新值让你重新核对
      await api.decideCell(matterId, grid.table.table_id, body).catch(async (e) => {
        await loadGrid();
        throw e;
      });
      setEdit(null);
      await loadGrid();
      await loadTables();
    });

  const tpl = templates.find((t) => t.id === creating?.template);
  const counts = grid ? tableCounts(grid.table, grid.cells) : null;
  const sel = picked && grid ? { doc: grid.docs.find((d) => d.document_version_id === picked.doc), col: grid.table.columns.find((c) => c.key === picked.col), cell: cellAt.get(`${picked.doc}\u0000${picked.col}`) } : null;
  const filtered = (grid?.docs ?? []).filter((d) => !onlyOpen || grid!.table.columns.some((c) => openAt(d.document_version_id, c)));
  const rows = sortDocs(filtered, sort?.key ?? null, sort?.dir ?? 1, (d, k) => cellText(cellAt.get(`${d.document_version_id}\u0000${k}`), plain));
  const sortBy = (key: string) => setSort((cur) => (cur?.key === key ? (cur.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }));
  const sortMark = (key: string) => (sort?.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : "");
  const step = (dir: 1 | -1) => {
    if (!grid) return;
    const next = nextOpenCell(rows, grid.table.columns, (doc, col) => openAt(doc, grid.table.columns.find((c) => c.key === col)!), picked, dir);
    if (next) {
      setPicked(next);
      setEdit(null);
      setCtx(null);
    } else setMsg({ tone: "ok", text: "没有未核的格子了。" });
  };
  // 复核模式（沿用工作台快捷键）：J / K 逐个未核格子，A 确认，E 改值，Esc 退出；输入框里打字时不响应
  useEffect(() => {
    if (!reviewMode || readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j") step(1);
      else if (k === "k") step(-1);
      else if (k === "escape") setReviewMode(false);
      else if (sel?.cell && k === "a" && sel.cell.state !== "verified" && sel.cell.state !== "edited") void decide({ cell_id: sel.cell.cell_id, decision: "verify", ...(sel.cell.updated_at ? { expected_updated_at: sel.cell.updated_at } : {}) }).then(() => step(1));
      else if (sel?.col && k === "e") setEdit(sel.cell?.state === "edited" ? (sel.cell.lawyer_value ?? "") : plain(sel.cell?.value ?? null));
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const draft = () =>
    run(async () => {
      if (!grid) return;
      if (grid.table.template === "contract_ledger") {
        const r = await api.tableReminderCandidates(matterId, grid.table.table_id);
        if (r.candidates.length === 0) return setMsg({ tone: "ok", text: "台账里还没有到期日：先填表、核对后再设提醒。" });
        setCands(r.candidates.map((c) => ({ ...c, pick: c.verified && !!c.date, due: c.date ?? "" })));
        return;
      }
      const r = await api.tableDraft(matterId, grid.table.table_id);
      notifyDataChanged();
      onExported?.();
      setMsg({ tone: "ok", text: `已生成《${r.filename}》草稿，在交付件里复核${r.open > 0 ? `；其中 ${r.open} 处没核，已标“待核”` : ""}。` });
    });
  const createReminders = () =>
    run(async () => {
      if (!cands) return;
      const chosen = cands.filter((c) => c.pick && /^\d{4}-\d{2}-\d{2}$/.test(c.due));
      for (const c of chosen) await api.reminderCreate({ matter_id: matterId, kind: "contract", due_date: c.due, days_before: 30, remind_time: "09:00", audience: "me", note: `${c.filename.replace(/\.[^.]+$/, "")}${c.label}` });
      setCands(null);
      notifyDataChanged();
      setMsg({ tone: "ok", text: `已设 ${chosen.length} 条到期提醒（提前 30 天），在“期限提醒”里可改。` });
    });

  return (
    <div className="tr">
      <div className="tr-bar">
        {tables.length > 0 && (
          <Select
            className="select-sm"
            aria-label="选择审阅表"
            value={current ?? ""}
            onChange={(v) => {
              setCurrent(v);
              setPicked(null);
            }}
            options={tables.map((t) => ({ value: t.table_id, label: `${t.title}（${t.document_version_ids.length} 份）` }))}
          />
        )}
        {!readOnly && !creating && (
          <button className={tables.length === 0 ? "btn-primary" : "btn-ghost"} disabled={busy || usable.length === 0} onClick={startCreate} title={usable.length === 0 ? "先添加材料" : undefined}>
            新建审阅表
          </button>
        )}
        {grid && !readOnly && (
          <>
            <button className="btn-primary" disabled={busy} onClick={() => onFill(grid.table)}>
              让助手填表
            </button>
            {onAsk && (
              <button className={ask !== null ? "btn-primary" : "btn-ghost"} disabled={busy || (counts?.total ?? 0) === (counts?.empty ?? 0)} title={(counts?.total ?? 0) === (counts?.empty ?? 0) ? "先填表" : "只依据表里的格子回答，每个结论写明材料与列"} onClick={() => setAsk((v) => (v === null ? "" : null))}>
                问这张表
              </button>
            )}
            <button
              className="btn-ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api.exportTable(matterId, grid.table.table_id);
                  setMsg({ tone: "ok", text: `已导出《${r.filename}》，在交付件里下载；没核的格子标了“待核”。` });
                  onExported?.();
                })
              }
            >
              导出 Excel
            </button>
            <button className="btn-ghost" disabled={busy} onClick={() => void draft()} title="只用你核过的格子；没核的在成果里标“待核”">
              {draftLabel(grid.table.template)}
            </button>
            <button
              className="btn-ghost"
              disabled={busy || (counts?.done ?? 0) === 0}
              title={(counts?.done ?? 0) === 0 ? "先核对格子" : "已核、已改的格子送进“事实”，作为你确认过的事实"}
              onClick={() =>
                void run(async () => {
                  const r = await api.tablePushFacts(matterId, grid.table.table_id);
                  notifyDataChanged();
                  setMsg({ tone: "ok", text: `推进“事实” ${r.pushed} 条${r.already ? `，${r.already} 条以前推过` : ""}${r.not_verified ? `；${r.not_verified} 格没核，没有推` : ""}。` });
                })
              }
            >
              推为事实
            </button>
            <button className="btn-ghost" disabled={busy || grid.table.columns.length >= 15} onClick={() => setNewCol({ label: "", hint: "", format: "text", options: "", whenCol: "", whenEq: "" })}>
              加一列
            </button>
            <button className={reviewMode ? "btn-primary" : "btn-ghost"} aria-pressed={reviewMode} onClick={() => { setReviewMode((v) => !v); if (!reviewMode && !picked) step(1); }} title="J / K 逐个未核的格子，A 确认，E 改值，Esc 退出">
              复核模式
            </button>
          </>
        )}
        {grid && (
          <label className="lifecycle-check">
            <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} aria-label="只看还有未核格子的材料" />
            只看未核
          </label>
        )}
      </div>
      {msg && <div className={`banner ${msg.tone === "err" ? "banner-red" : "banner-green"}`}>{msg.text}</div>}
      {ask !== null && grid && onAsk && (
        <div className="card tr-create" role="region" aria-label="问这张表">
          <div className="tr-field">
            <span className="rc-k">问什么</span>
            <input value={ask} maxLength={300} onChange={(e) => setAsk(e.target.value)} placeholder="例如：哪些合同有控制权变更条款？到期日在明年上半年的有几份？" aria-label="问这张表的问题" />
          </div>
          <div className="card-actions">
            <button className="btn-primary" disabled={busy || !ask.trim()} onClick={() => { onAsk(grid.table, ask.trim()); setAsk(null); }}>
              问
            </button>
            <button className="btn-ghost" disabled={busy} onClick={() => setAsk(null)}>
              取消
            </button>
          </div>
          <p className="muted">助手只看这张表里的格子回答，不改表；没核的格子在回答里标“待核”。表里没有的，建议你加一列后再填表。</p>
        </div>
      )}
      {reviewMode && <p className="muted">复核模式：J / K 到下一个、上一个未核的格子，A 确认，E 改值，Esc 退出。</p>}
      {newCol && grid && (
        <div className="card tr-create">
          <div className="card-title">加一列</div>
          <div className="tr-field">
            <span className="rc-k">列名</span>
            <input value={newCol.label} maxLength={20} onChange={(e) => setNewCol({ ...newCol, label: e.target.value })} placeholder="例如：保证金" aria-label="列名" />
          </div>
          <div className="tr-field">
            <span className="rc-k">要找什么</span>
            <input value={newCol.hint} maxLength={200} onChange={(e) => setNewCol({ ...newCol, hint: e.target.value })} placeholder="例如：履约保证金金额；没有写“未约定”" aria-label="填写说明" />
          </div>
          <div className="tr-field">
            <span className="rc-k">格式</span>
            <Select className="select-sm" aria-label="格式" value={newCol.format} onChange={(v) => setNewCol({ ...newCol, format: v as TableColumnView["format"] })} options={COLUMN_FORMATS.map((f) => ({ value: f.value, label: f.label }))} />
            {newCol.format === "choice" && <input value={newCol.options} onChange={(e) => setNewCol({ ...newCol, options: e.target.value })} placeholder="选项用顿号隔开，如：买卖、租赁、服务" aria-label="选项" />}
          </div>
          {condCols.length > 0 && (
            <div className="tr-field">
              <span className="rc-k">什么时候填</span>
              <Select
                className="select-sm"
                aria-label="什么时候填"
                value={newCol.whenCol}
                onChange={(v) => setNewCol({ ...newCol, whenCol: v, whenEq: "" })}
                options={[{ value: "", label: "每份材料都填" }, ...condCols.map((c) => ({ value: c.key, label: `只在“${c.label}”为…时填` }))]}
              />
              {newCol.whenCol && (
                <Select
                  className="select-sm"
                  aria-label="条件的值"
                  value={newCol.whenEq}
                  onChange={(v) => setNewCol({ ...newCol, whenEq: v })}
                  options={[{ value: "", label: "选一个值" }, ...(() => { const c = condCols.find((x) => x.key === newCol.whenCol)!; return (c.format === "yesno" ? ["是", "否"] : (c.options ?? [])).map((o) => ({ value: o, label: o })); })()]}
                />
              )}
            </div>
          )}
          <div className="card-actions">
            <button
              className="btn-primary"
              disabled={busy || !newCol.label.trim() || !newCol.hint.trim() || (!!newCol.whenCol && !newCol.whenEq)}
              onClick={() =>
                void run(async () => {
                  await api.tableAddColumn(matterId, grid.table.table_id, { label: newCol.label.trim(), hint: newCol.hint.trim(), format: newCol.format, ...(newCol.format === "choice" ? { options: newCol.options.split(/[、,，;；\s]+/).filter(Boolean) } : {}), ...(newCol.whenCol ? { when: { column: newCol.whenCol, equals: newCol.whenEq } } : {}) });
                  setNewCol(null);
                  await loadGrid();
                  await loadTables();
                })
              }
            >
              加上
            </button>
            <button className="btn-ghost" disabled={busy} onClick={() => setNewCol(null)}>
              取消
            </button>
          </div>
          <p className="muted">新列对每份材料都是空格；“让助手填表”时一并填写。只在某列为某个值时才填的，选“什么时候填”，其余材料显示“不适用”。</p>
        </div>
      )}
      {cands && (
        <div className="card tr-create" role="region" aria-label="据此设到期提醒">
          <div className="card-title">据此设到期提醒（逐条确认）</div>
          {cands.map((c, i) => (
            <div key={`${c.document_version_id}${c.column}`} className="tr-field">
              <label className="lifecycle-check">
                <input type="checkbox" checked={c.pick} disabled={!c.verified} onChange={(e) => setCands(cands.map((x, j) => (j === i ? { ...x, pick: e.target.checked } : x)))} />
                {c.filename} · {c.label}
              </label>
              <input type="date" value={c.due} aria-label={`${c.filename}的${c.label}`} onChange={(e) => setCands(cands.map((x, j) => (j === i ? { ...x, due: e.target.value } : x)))} />
              <span className="muted">{!c.verified ? "这一格还没核，先核对" : c.note}</span>
            </div>
          ))}
          <div className="card-actions">
            <button className="btn-primary" disabled={busy || !cands.some((c) => c.pick && c.due)} onClick={() => void createReminders()}>
              设提醒（{cands.filter((c) => c.pick && c.due).length} 条，提前 30 天）
            </button>
            <button className="btn-ghost" disabled={busy} onClick={() => setCands(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {creating && tpl && (
        <div className="card tr-create">
          <div className="card-title">新建审阅表</div>
          <div className="tr-field">
            <span className="rc-k">模板</span>
            <Select
              className="select-sm"
              aria-label="模板"
              value={creating.template}
              onChange={(v) => {
                const t = templates.find((x) => x.id === v)!;
                setCreating({ ...creating, template: v, columns: t.columns.map((c) => c.key) });
              }}
              options={templates.map((t) => ({ value: t.id, label: `${t.title}（${t.line}）` }))}
            />
          </div>
          <div className="tr-field">
            <span className="rc-k">列</span>
            <span className="tr-checks">
              {tpl.columns.map((c) => (
                <label key={c.key} className="lifecycle-check" title={c.hint}>
                  <input
                    type="checkbox"
                    checked={creating.columns.includes(c.key)}
                    onChange={(e) => setCreating({ ...creating, columns: e.target.checked ? tpl.columns.map((x) => x.key).filter((k) => k === c.key || creating.columns.includes(k)) : creating.columns.filter((k) => k !== c.key) })}
                  />
                  {c.label}
                </label>
              ))}
            </span>
          </div>
          <div className="tr-field">
            <span className="rc-k">材料</span>
            <span className="tr-checks">
              {usable.map((d) => (
                <label key={d.document_version_id} className="lifecycle-check">
                  <input
                    type="checkbox"
                    checked={creating.docs.includes(d.document_version_id)}
                    onChange={(e) => setCreating({ ...creating, docs: e.target.checked ? [...creating.docs, d.document_version_id] : creating.docs.filter((x) => x !== d.document_version_id) })}
                  />
                  {d.filename}
                </label>
              ))}
            </span>
          </div>
          <p className="muted">一行一份材料、一列一个问题。助手每格写答案并附原文，你逐格核对；核过的格子助手重填时不会改。读不出文字的材料整行标“读取差”。</p>
          <div className="card-actions">
            <button className="btn-primary" disabled={busy || creating.columns.length === 0 || creating.docs.length === 0} onClick={() => void create()}>
              建表（{creating.docs.length} 份 × {creating.columns.length} 列）
            </button>
            <button className="btn-ghost" disabled={busy} onClick={() => setCreating(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {!grid && !creating && tables.length === 0 && <p className="muted">多份材料要回答同一组问题时（证据清单、合同尽调、合同台账），建一张审阅表，逐格核对比逐份看更不容易漏。</p>}

      {grid && counts && (
        <>
          <div className="muted tr-counts">
            共 {counts.total} 格 · 已核 {counts.done}
            {counts.conflict > 0 && ` · 有冲突 ${counts.conflict}`}
            {counts.quoteMissing > 0 && ` · 原文对不上 ${counts.quoteMissing}`}
            {counts.empty > 0 && ` · 还没填 ${counts.empty}`}
            {counts.na > 0 && ` · 不适用 ${counts.na}`}
          </div>
          <div className="tr-scroll">
            <table className="data tr-grid">
              <thead>
                <tr>
                  <th aria-sort={sort?.key === "__doc" ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                    <button className="th-sort" onClick={() => sortBy("__doc")}>材料{sortMark("__doc")}</button>
                  </th>
                  {grid.table.columns.map((c) => (
                    <th key={c.key} title={c.when ? `${c.hint}（${whenText(c, grid.table.columns)}）` : c.hint} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                      <button className="th-sort" onClick={() => sortBy(c.key)}>{c.label}{sortMark(c.key)}</button>
                      {c.when && <span className="th-when muted">{whenText(c, grid.table.columns)}</span>}
                      {!readOnly && c.key.startsWith("custom_") && (
                        <ConfirmButton
                          className="btn-link th-del"
                          label="去掉"
                          question={`去掉“${c.label}”这一列？这一列已核、已改的格子一并删除`}
                          confirmLabel="去掉这一列"
                          disabled={busy}
                          onConfirm={() =>
                            run(async () => {
                              await api.tableRemoveColumn(matterId, grid.table.table_id, c.key, true);
                              await loadGrid();
                              await loadTables();
                            })
                          }
                        />
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.document_version_id}>
                    <td className="tr-doc">{d.filename}</td>
                    {grid.table.columns.map((c) => {
                      const cell = cellAt.get(`${d.document_version_id}\u0000${c.key}`);
                      const on = picked?.doc === d.document_version_id && picked.col === c.key;
                      if (notApplicable(d.document_version_id, c))
                        return (
                          <td key={c.key} className="tr-cell cell-na" aria-label={`${d.filename} · ${c.label}：不适用（${whenText(c, grid.table.columns)}）`}>
                            <span className="tr-state">不适用</span>
                          </td>
                        );
                      return (
                        <td key={c.key} className={`tr-cell ${cell ? CELL_STATE_CLASS[cell.state] : "cell-empty"}${on ? " tr-cell-on" : ""}`}>
                          <button className="tr-cell-btn" onClick={() => { setPicked(on ? null : { doc: d.document_version_id, col: c.key }); setCtx(null); }} aria-label={`${d.filename} · ${c.label}：${cell ? CELL_STATE_TEXT[cell.state] : "还没填"}`}>
                            <span className="tr-val">{cellText(cell, plain) || (cell ? "" : "—")}</span>
                            {cell && cell.state !== "verified" && cell.state !== "edited" && <span className="tr-state">{CELL_STATE_TEXT[cell.state]}</span>}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sel?.doc && sel.col && (
            <div className="card tr-detail" role="region" aria-label="格子详情">
              <div className="card-title">
                {sel.doc.filename} · {sel.col.label} <span className="tag tag-gray">{sel.cell ? CELL_STATE_TEXT[sel.cell.state] : "还没填"}</span>
              </div>
              {sel.cell?.state === "edited" && (
                <div className="rc-row">
                  <span className="rc-k">你的值</span>
                  <span>{sel.cell.lawyer_value}</span>
                </div>
              )}
              {sel.cell?.value && (
                <div className="rc-row">
                  <span className="rc-k">{sel.cell.state === "edited" ? "助手原来填的" : "助手填的"}</span>
                  <span>{plain(sel.cell.value)}</span>
                </div>
              )}
              {sel.cell?.quote && (
                <div className="rc-row">
                  <span className="rc-k">原文</span>
                  <span className="rc-quote">
                    {plain(sel.cell.quote)}
                    {sel.cell.anchor_status === "not_found" && <span className="rc-warn">这段原文在材料里找不到，请打开原件核对</span>}
                    {sel.cell.anchor_status !== "not_found" && ctx?.cell !== sel.cell.cell_id && (
                      <button className="btn-link" onClick={() => void run(async () => { const r = await api.tableCellContext(matterId, grid.table.table_id, sel.cell!.cell_id); const all = `${r.before}${r.quote}${r.after}`; if (all.includes("〔")) { const more = await restoreTokens(matterId, all); setMap((m) => new Map([...m, ...more])); } setCtx({ cell: sel.cell!.cell_id, ...r }); })}>
                        看原文前后
                      </button>
                    )}
                  </span>
                </div>
              )}
              {ctx && sel.cell && ctx.cell === sel.cell.cell_id && (
                <div className="rc-row">
                  <span className="rc-k">材料原文</span>
                  <span className="tr-context">
                    {ctx.located ? (
                      <>
                        {plain(ctx.before)}
                        <mark>{plain(ctx.quote)}</mark>
                        {plain(ctx.after)}
                      </>
                    ) : (
                      <span className="rc-warn">这段原文在材料里找不到，请打开原件核对</span>
                    )}
                  </span>
                </div>
              )}
              {sel.cell?.note && (
                <div className="rc-row">
                  <span className="rc-k">说明</span>
                  <span className="muted">{plain(sel.cell.note)}</span>
                </div>
              )}
              {!readOnly &&
                (edit !== null ? (
                  <div className="rc-edit">
                    <input value={edit} onChange={(e) => setEdit(e.target.value)} aria-label={`${sel.col.label}的值`} placeholder={sel.col.hint} />
                    {formatProblem(sel.col, edit) && edit.trim() && <span className="rc-warn">{formatProblem(sel.col, edit)}</span>}
                    <div className="rc-actions">
                      <button
                        className="btn-primary"
                        disabled={busy || !!formatProblem(sel.col, edit)}
                        onClick={() => void decide(sel.cell ? { cell_id: sel.cell.cell_id, decision: "edit", value: edit.trim(), ...(sel.cell.updated_at ? { expected_updated_at: sel.cell.updated_at } : {}) } : { document_version_id: sel.doc!.document_version_id, column: sel.col!.key, decision: "edit", value: edit.trim() })}
                      >
                        保存
                      </button>
                      <button className="btn-ghost" disabled={busy} onClick={() => setEdit(null)}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="rc-actions">
                    {sel.cell && sel.cell.state !== "verified" && sel.cell.state !== "edited" && (
                      <button className="btn-primary" disabled={busy} onClick={() => void decide({ cell_id: sel.cell!.cell_id, decision: "verify", ...(sel.cell!.updated_at ? { expected_updated_at: sel.cell!.updated_at } : {}) })}>
                        {sel.cell.value ? "确认" : "确认没有"}
                      </button>
                    )}
                    <button className="btn-ghost" disabled={busy} onClick={() => setEdit(sel.cell?.state === "edited" ? (sel.cell.lawyer_value ?? "") : plain(sel.cell?.value ?? null))}>
                      {sel.cell?.value || sel.cell?.state === "edited" ? "改值" : "填写"}
                    </button>
                    {sel.cell && (sel.cell.state === "verified" || sel.cell.state === "edited") && (
                      <button className="btn-link" disabled={busy} onClick={() => void decide({ cell_id: sel.cell!.cell_id, decision: "reset" })}>
                        撤回（助手可再填）
                      </button>
                    )}
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
