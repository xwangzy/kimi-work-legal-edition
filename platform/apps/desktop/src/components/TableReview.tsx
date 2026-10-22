/**
 * 事项“材料 → 表格审阅”（v9.4 第 19 批 C-01；评审 C1 §3.3）：行 = 材料，列 = 问题，格 = 带原文出处的答案 + 复核状态。
 * 选模板（证据清单 / 合同尽调摘要 / 合同台账）与材料建表 → “让助手填表”（tabular-review 方法，表编号作方法参数）→
 * 逐格核：点格子看引文，确认 / 改值（原 AI 值保留）/ 撤回；已核、已改的格子助手重填时不覆盖 → 导出 Excel（未核的标“待核”）。
 * 格子文字是事项令牌形态，按事项令牌表还原显示；律师改的值为原文。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { restoredPlain, restoreTokens } from "../lib/tokens.ts";
import { CELL_STATE_CLASS, CELL_STATE_TEXT, cellText, formatProblem, isOpen, tableCounts, type CellView, type TableColumnView, type TableView } from "../lib/table-review.ts";
import { Select } from "./Select.tsx";

interface Props {
  matterId: string;
  docs: { document_version_id: string; filename: string; quarantined_at?: string | null }[];
  readOnly: boolean;
  /** 让助手填表：上层按方法 tabular-review、表编号作方法参数、表里的材料发起任务（先估价确认）。 */
  onFill: (table: TableView) => void;
  /** 导出后通知上层刷新交付件。 */
  onExported?: () => void;
}

type Template = { id: string; title: string; line: string; columns: TableColumnView[] };

export function TableReview({ matterId, docs, readOnly, onFill, onExported }: Props) {
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

  const loadTables = useCallback(async () => {
    const r = await api.tables(matterId);
    setTables(r.tables);
    setCurrent((c) => c ?? r.tables[0]?.table_id ?? null);
  }, [matterId]);
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
      await api.decideCell(matterId, grid.table.table_id, body);
      setEdit(null);
      await loadGrid();
      await loadTables();
    });

  const tpl = templates.find((t) => t.id === creating?.template);
  const counts = grid ? tableCounts(grid.table, grid.cells) : null;
  const sel = picked && grid ? { doc: grid.docs.find((d) => d.document_version_id === picked.doc), col: grid.table.columns.find((c) => c.key === picked.col), cell: cellAt.get(`${picked.doc}\u0000${picked.col}`) } : null;
  const rows = (grid?.docs ?? []).filter((d) => !onlyOpen || grid!.table.columns.some((c) => isOpen(cellAt.get(`${d.document_version_id}\u0000${c.key}`))));

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
          </div>
          <div className="tr-scroll">
            <table className="data tr-grid">
              <thead>
                <tr>
                  <th>材料</th>
                  {grid.table.columns.map((c) => (
                    <th key={c.key} title={c.hint}>
                      {c.label}
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
                      return (
                        <td key={c.key} className={`tr-cell ${cell ? CELL_STATE_CLASS[cell.state] : "cell-empty"}${on ? " tr-cell-on" : ""}`}>
                          <button className="tr-cell-btn" onClick={() => setPicked(on ? null : { doc: d.document_version_id, col: c.key })} aria-label={`${d.filename} · ${c.label}：${cell ? CELL_STATE_TEXT[cell.state] : "还没填"}`}>
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
                        onClick={() => void decide(sel.cell ? { cell_id: sel.cell.cell_id, decision: "edit", value: edit.trim() } : { document_version_id: sel.doc!.document_version_id, column: sel.col!.key, decision: "edit", value: edit.trim() })}
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
                      <button className="btn-primary" disabled={busy} onClick={() => void decide({ cell_id: sel.cell!.cell_id, decision: "verify" })}>
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
