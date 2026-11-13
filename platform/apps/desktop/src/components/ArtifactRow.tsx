/**
 * 成果行（V18 A2）：事项“成果”页与全局“成果”页共用。每份文件一行（最新版），旧版收进“版本记录（n）”；
 * 每个任务组末尾一行可展开的“过程文件（n）”（答复摘要、独立复核意见）。旧版与过程文件不给“提交复核”。
 * 只改显示：提交复核、预览、下载都对着具体那一个版本（最新版或展开后的那一版）。
 */
import { useState } from "react";
import { downloadPlan } from "../lib/download.ts";
import { fileTypeLabel, type FileEntry } from "../lib/deliverables.ts";
import { ARTIFACT_STATUS_LABELS, AUDIENCE_LABELS, fmtTime, fmtWhen } from "../lib/labels.ts";

const STATUS_TONE: Record<string, string> = { draft: "pill-gray", pending_review: "pill-orange", approved: "pill-green", rejected: "pill-red", superseded: "pill-gray" };

export interface ListRow {
  artifact_version_id: string;
  kind: string;
  filename: string;
  status: string;
  version: number;
  audience?: string | null;
  created_at: string;
  is_latest?: boolean;
  /** 列表里显示的名称（已还原代号）。 */
  display: string;
}

/** 状态胶囊（v9.4 U1 #15）：第 2 版起才写版数，受众放悬停提示。 */
export function StatusPill({ r }: { r: { status: string; version: number; audience?: string | null } }) {
  return (
    <span className={`pill ${STATUS_TONE[r.status] ?? "pill-gray"}`} title={r.audience ? `受众：${AUDIENCE_LABELS[r.audience] ?? r.audience}` : undefined}>
      {ARTIFACT_STATUS_LABELS[r.status] ?? r.status}
      {r.version > 1 ? ` · 第 ${r.version} 版` : ""}
    </span>
  );
}

/** 行首的文件类型（Word / Excel / 文本）。 */
export function FileTypeTag({ filename }: { filename: string }) {
  const t = fileTypeLabel(filename);
  return <span className={`dl-ftype dl-ftype-${t === "Word" ? "word" : t === "Excel" ? "excel" : "other"}`}>{t}</span>;
}

/** 下载按钮：文字按下载下来的文件类型（Markdown 文本下载时转成 Word，见 download.ts）。 */
function DownloadButton({ r, onDownload, small = true }: { r: ListRow; onDownload: (r: ListRow) => void; small?: boolean }) {
  const plan = downloadPlan(r.filename);
  return (
    <button className={`btn-ghost${small ? " btn-sm" : ""}`} title={/\.(md|markdown)$/i.test(r.filename) ? "这份是文本，下载时转成 Word" : undefined} onClick={() => onDownload(r)}>
      {plan.label}
    </button>
  );
}

/**
 * 一份文件：最新版一行 + 可展开的旧版。showStatus：是否单列状态（全局页按状态筛选时不单列，受众与版数补在名称后）。
 */
export function FileRows<T extends ListRow>({ entry, showStatus, onOpen, onDownload, onSubmit, busyId }: { entry: FileEntry<T>; showStatus: boolean; onOpen: (r: T) => void; onDownload: (r: ListRow) => void; onSubmit?: (r: T) => void; busyId?: string | null }) {
  const [open, setOpen] = useState(false);
  const r = entry.latest;
  return (
    <>
      <tr className="row-link dl-in-task dl-file" onClick={() => onOpen(r)}>
        <td title={r.filename}>
          <FileTypeTag filename={r.filename} />
          <b>{r.display}</b>
          {!showStatus && r.audience && r.audience !== "internal" ? <span className="muted"> · 给{AUDIENCE_LABELS[r.audience] ?? r.audience}</span> : null}
          {!showStatus && r.version > 1 ? <span className="muted"> · 第 {r.version} 版</span> : null}
          {entry.replaced ? <span className="muted"> · 后面的任务里有更新的版本</span> : null}
        </td>
        {showStatus && <td><StatusPill r={r} /></td>}
        <td className="nowrap" title={fmtTime(r.created_at)}>{fmtWhen(r.created_at)}</td>
        <td className="dl-actions" onClick={(e) => e.stopPropagation()}>
          {entry.older.length > 0 && (
            <button className="btn-link dl-ver-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              版本记录（{entry.older.length}）
            </button>
          )}
          {onSubmit && r.status === "draft" && !entry.replaced && (
            <button className="btn-ghost btn-sm" disabled={busyId === r.artifact_version_id} onClick={() => onSubmit(r)}>提交复核</button>
          )}
          <DownloadButton r={r} onDownload={onDownload} />
        </td>
      </tr>
      {open &&
        entry.older.map((o) => (
          <tr key={o.artifact_version_id} className="dl-ver">
            <td title={o.filename}>
              <span className="dl-ver-name">第 {o.version} 版</span>
              <span className="muted"> · 已有更新版本</span>
            </td>
            {showStatus && <td><StatusPill r={o} /></td>}
            <td className="nowrap" title={fmtTime(o.created_at)}>{fmtWhen(o.created_at)}</td>
            <td className="dl-actions">
              <DownloadButton r={o} onDownload={onDownload} />
            </td>
          </tr>
        ))}
    </>
  );
}

/** 任务组末尾的“过程文件（n）”：答复摘要、独立复核意见，默认收起；里面只有下载。 */
export function ProcessRows<T extends ListRow>({ entries, colSpan, showStatus, onDownload }: { entries: FileEntry<T>[]; colSpan: number; showStatus: boolean; onDownload: (r: ListRow) => void }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <>
      <tr className="dl-proc">
        <td colSpan={colSpan}>
          <button className="btn-link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            过程文件（{entries.length}）<span className="dl-proc-chev" aria-hidden="true">›</span>
          </button>
          <span className="muted dl-proc-note">答复摘要与复核意见，留作记录，不用交出去</span>
        </td>
      </tr>
      {open &&
        entries.map((e) => (
          <tr key={e.latest.artifact_version_id} className="dl-proc-row">
            <td title={e.latest.filename}>
              <FileTypeTag filename={e.latest.filename} />
              <span>{e.latest.display}</span>
            </td>
            {showStatus && <td />}
            <td className="nowrap" title={fmtTime(e.latest.created_at)}>{fmtWhen(e.latest.created_at)}</td>
            <td className="dl-actions">
              <DownloadButton r={e.latest} onDownload={onDownload} />
            </td>
          </tr>
        ))}
    </>
  );
}
